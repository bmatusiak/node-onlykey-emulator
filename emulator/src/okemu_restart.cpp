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
    okemu_request_restart();
    siglongjmp(g_park, 1);            /* never returns */
  }

  if (at >= kSCBPage && at < kSCBPage + kPageSize) {
    /* Some other Cortex-M system register. Let the write through. */
    mprotect((void *)kSCBPage, kPageSize, PROT_READ | PROT_WRITE);
    return;
  }

  /* A genuine crash - restore the default handler and let it stand, so we
   * don't turn a real bug into a silent hang. */
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
