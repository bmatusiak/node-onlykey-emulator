/*
 * okemu_restart.cpp - turning CPU_RESTART() into a JavaScript event.
 *
 * okcore.h defines:
 *     #define CPU_RESTART_ADDR (uint32_t *)0xE000ED0C
 *     #define CPU_RESTART()    (*CPU_RESTART_ADDR = CPU_RESTART_VAL)
 *
 * i.e. a write to the Cortex-M Application Interrupt and Reset Control
 * Register. On hardware the core resets immediately and nothing after the
 * write executes. Against the HAL's plain mapped memory the store would simply
 * succeed and the firmware would carry on running in a state it believes is
 * unreachable - it uses CPU_RESTART() for lock timeouts, integrity failures
 * and post-wipe reinitialisation, so continuing is never correct.
 *
 * So the page holding AIRCR is mapped read-only and the store faults. The
 * handler recognises the address, parks the firmware thread via siglongjmp,
 * and the restart sink notifies JS. The process itself is left alone: the JS
 * side decides whether to respawn (and flash.bin / eeprom.bin persist across
 * that, so a reboot preserves device state exactly as it would on hardware).
 *
 * Faults elsewhere on the page are not restart requests. Rather than guess, we
 * unprotect the page and let the store retry so the firmware keeps running.
 */
#include <signal.h>
#include <execinfo.h>
#include <stdlib.h>
#include <time.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

#include "ok_hal.h"

/* Provided by the firmware: OnlyKey.ino's setup() and SoftTimer's loop(). */
extern "C" void setup(void);
extern "C" void loop(void);

namespace {

const uintptr_t kAIRCR     = 0xE000ED0CUL;
const size_t    kPageSize  = 4096;
const uintptr_t kSCBPage   = kAIRCR & ~(uintptr_t)(kPageSize - 1);

sigjmp_buf         g_park;
volatile sig_atomic_t g_armed = 0;
struct sigaction   g_prev_segv;

okemu_event_sink g_restart_fn  = nullptr;
void            *g_restart_ctx = nullptr;

void segv_handler(int sig, siginfo_t *info, void *uctx) {
  const uintptr_t at = (uintptr_t)info->si_addr;

  if (g_armed && at >= kAIRCR && at < kAIRCR + 4) {
    /*
     * The firmware has ~10 CPU_RESTART() sites (integrity check, PIN flows,
     * wipes, bootloader entry) and they all look identical from outside: the
     * process just exits and pm2 respawns it. Reporting the call stack turns
     * "it rebooted" into "it rebooted HERE", which is the only practical way
     * to tell an expected reboot from a spurious one.
     *
     * Off by default - a reboot is normal operation. Set OKEMU_TRACE_RESTART=1.
     */
    if (getenv("OKEMU_TRACE_RESTART")) {
      static const char msg[] = "\n[okemu] CPU_RESTART() from:\n";
      write(STDERR_FILENO, msg, sizeof msg - 1);
      void *frames[24];
      int depth = backtrace(frames, 24);
      backtrace_symbols_fd(frames, depth, STDERR_FILENO);
    }
    okemu_request_restart();
    siglongjmp(g_park, 1);            /* never returns */
  }

  if (at >= kSCBPage && at < kSCBPage + kPageSize) {
    /* Some other Cortex-M system register. Let the write through. */
    mprotect((void *)kSCBPage, kPageSize, PROT_READ | PROT_WRITE);
    return;
  }

  /*
   * A genuine crash. Print a backtrace before letting the default handler
   * take it: the firmware runs on its own thread inside a Node addon, so a
   * fault here shows up only as pm2 silently respawning the daemon, with
   * nothing in either log to say why. ptrace_scope commonly blocks attaching
   * gdb after the fact, so self-reporting is the reliable option.
   */
  {
    static const char msg[] = "\n[okemu] FATAL: segfault at ";
    write(STDERR_FILENO, msg, sizeof msg - 1);
    char addr[32];
    int n = snprintf(addr, sizeof addr, "%p\n", info->si_addr);
    write(STDERR_FILENO, addr, n > 0 ? (size_t)n : 0);

    void *frames[32];
    int depth = backtrace(frames, 32);
    backtrace_symbols_fd(frames, depth, STDERR_FILENO);
  }

  sigaction(SIGSEGV, &g_prev_segv, nullptr);
  (void)sig; (void)uctx;
}

void arm_restart_trap() {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = segv_handler;
  sa.sa_flags = SA_SIGINFO | SA_NODEFER;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGSEGV, &sa, &g_prev_segv);

  mprotect((void *)kSCBPage, kPageSize, PROT_READ);
  g_armed = 1;
}

}  // namespace

extern "C" {

void okemu_set_restart_sink(okemu_event_sink fn, void *ctx) {
  g_restart_fn = fn;
  g_restart_ctx = ctx;
}

void okemu_firmware_run(void) {
  if (sigsetjmp(g_park, 1) != 0) {
    /* Arrived here from the AIRCR trap: the firmware asked to reboot. */
    g_armed = 0;
    mprotect((void *)kSCBPage, kPageSize, PROT_READ | PROT_WRITE);
    okemu_hal_shutdown();
    if (g_restart_fn) g_restart_fn(g_restart_ctx);
    return;
  }

  arm_restart_trap();

  setup();
  for (;;) {
    loop();
    okemu_sync_systick();

    /*
     * Unreachable in practice: SoftTimerClass::run() is an infinite scheduler
     * loop, so loop() never returns. Kept because the contract of loop() does
     * not promise that, and a future SoftTimer could return between passes.
     * The CPU yield that actually matters lives in micros() - see
     * core-override/okemu_pins.cpp.
     */
  }
}

}  // extern "C"
