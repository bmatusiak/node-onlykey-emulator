/*
 * ok_hal.cpp - see ok_hal.h for the design rationale.
 */
#include "ok_hal.h"

#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include <chrono>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <string>
#include <vector>

namespace {

/* ------------------------------------------------------------ regions */

struct Region { uintptr_t base; size_t len; const char *name; bool required; };

/*
 * Kinetis peripheral windows the firmware touches, plus the Cortex-M system
 * block. Backing them with anonymous memory is what lets kinetis.h be used
 * unmodified: FTFL_*, SIM_*, PORTx_PCR*, TSI0_* all become plain loads/stores.
 */
const Region kPeripherals[] = {
  { 0x40000000UL, 0x00100000UL, "peripheral bridge", true  }, /* FTFL, SIM, PORT, TSI, ADC */
  /*
   * The bit-band alias is 32 MB and the firmware never uses the bit-band
   * macros, so it is optional. Reserving that much fixed address space
   * regularly collided with V8's own heap - MAP_FIXED_NOREPLACE then returns
   * EEXIST and, because ASLR moves the heap each run, the daemon crash-looped
   * intermittently. Skip it when the address is taken.
   */
  { 0x42000000UL, 0x02000000UL, "bitband alias",     false },
  { 0xE0000000UL, 0x00100000UL, "cortex-m system",   true  }, /* SysTick, NVIC, SCB */
};

/* Registers the firmware reads for identity/state, by absolute address. */
volatile uint32_t *reg32(uintptr_t a) { return (volatile uint32_t *)a; }
volatile uint8_t  *reg8 (uintptr_t a) { return (volatile uint8_t  *)a; }

const uintptr_t kSIM_SDID  = 0x40048024UL;
const uintptr_t kSIM_UIDH  = 0x40048054UL;
const uintptr_t kSIM_UIDMH = 0x40048058UL;
const uintptr_t kSIM_UIDML = 0x4004805CUL;
const uintptr_t kSIM_UIDL  = 0x40048060UL;
const uintptr_t kFTFL_FSTAT = 0x40020000UL;
const uintptr_t kFTFL_FSEC  = 0x40020002UL;  /* per kinetis.h:2350 */

/* ------------------------------------------------------------- state */

struct Hal {
  std::mutex mu;

  /* storage */
  std::string dir;
  uint8_t *flash = nullptr;     /* mapped at OKEMU_FLASH_BASE */
  int flash_fd = -1;
  size_t flash_mapped_off = 0;  /* first byte actually mapped (see init) */
  uint8_t eeprom[OKEMU_EEPROM_SIZE];
  int eeprom_fd = -1;

  /* time */
  uint64_t t0_us = 0;

  /* buttons */
  bool button[OKEMU_NUM_BUTTONS + 1] = { false };

  /* led */
  okemu_rgb px[OKEMU_NUM_PIXELS] = {};

  /* host -> device HID; each entry carries the interface it arrived on */
  struct InPkt { int iface; std::vector<uint8_t> data; };
  std::deque<InPkt> hid_in;
  std::condition_variable hid_cv;

  /* restart latch */
  bool restart = false;

  /* host -> device SEREMU (debug console input) */
  std::deque<uint8_t> seremu_in;

  /* sinks */
  okemu_stream_sink stream_sink = nullptr;  void *stream_ctx = nullptr;
  okemu_led_sink    led_sink    = nullptr;  void *led_ctx    = nullptr;
};

Hal g;

uint64_t now_us() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
}

/* Open `name` under the storage dir at `size` bytes, creating it filled with
 * `fill` if absent. Returns an fd or -1. */
int open_backing(const std::string &dir, const char *name, size_t size,
                 uint8_t fill, char *err, size_t errlen) {
  std::string path = dir + "/" + name;
  int fd = ::open(path.c_str(), O_RDWR | O_CREAT, 0600);
  if (fd < 0) {
    snprintf(err, errlen, "cannot open %s: %s", path.c_str(), strerror(errno));
    return -1;
  }
  struct stat st;
  if (fstat(fd, &st) == 0 && (size_t)st.st_size != size) {
    if (ftruncate(fd, 0) != 0 || ftruncate(fd, (off_t)size) != 0) {
      snprintf(err, errlen, "cannot size %s: %s", path.c_str(), strerror(errno));
      ::close(fd);
      return -1;
    }
    /* A blank NOR flash / EEPROM array reads as 0xFF. */
    std::vector<uint8_t> blank(65536, fill);
    size_t left = size;
    while (left) {
      size_t n = left < blank.size() ? left : blank.size();
      if (write(fd, blank.data(), n) != (ssize_t)n) {
        snprintf(err, errlen, "cannot init %s: %s", path.c_str(), strerror(errno));
        ::close(fd);
        return -1;
      }
      left -= n;
    }
  }
  return fd;
}

/*
 * Peripheral mapping must happen before ANY static initializer in the
 * firmware runs, not when okemu_hal_init() is called.
 *
 * T3Mac.cpp has a file-scope initializer that dereferences registers directly:
 *     unsigned long chipNum[4] = { SIM_UIDH, SIM_UIDMH, SIM_UIDML, SIM_UIDL };
 * That runs during dlopen(), long before JS can call start(). Without the
 * mapping already in place the addon segfaults as it loads.
 *
 * A constructor priority below the default (65535) orders this ahead of every
 * C++ global constructor in the module. Priorities 0-100 are reserved for the
 * implementation, so 101 is the earliest slot available to us.
 *
 * Only the anonymous peripheral windows are set up here - they need no
 * configuration. The flash mapping is file-backed and needs the storage
 * directory, so it stays in okemu_hal_init(); nothing reads flash until
 * setup() runs.
 */
int g_map_status = -1;   /* 0 = mapped, -1 = not yet, >0 = errno */
char g_map_error[256] = "peripheral mapping never ran";

__attribute__((constructor(101)))
void okemu_map_peripherals(void) {
  for (const Region &r : kPeripherals) {
    void *p = mmap((void *)r.base, r.len, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (p == MAP_FAILED || (uintptr_t)p != r.base) {
      if (p != MAP_FAILED) munmap(p, r.len);
      if (!r.required) {
        fprintf(stderr, "[okemu] note: %s at %#lx unavailable (%s) - skipped\n",
                r.name, (unsigned long)r.base, strerror(errno));
        continue;
      }
      g_map_status = errno ? errno : EFAULT;
      snprintf(g_map_error, sizeof g_map_error,
               "cannot map %s at %#lx: %s", r.name, (unsigned long)r.base,
               strerror(errno));
      return;
    }
  }

  /*
   * Identity registers must hold their values before chipNum's initializer
   * samples them. SIM_SDID's PINID nibble selects the hardware variant: the
   * firmware reads 5 as OK_HW_COLOR (the NeoPixel build) and 9 as OK_HW_DUO.
   */
  *reg32(kSIM_SDID) = 0x00000005;

  /* A stable fake 128-bit chip UID, so derived device keys are stable too. */
  *reg32(kSIM_UIDH)  = 0x4F4B454D; /* "OKEM" */
  *reg32(kSIM_UIDMH) = 0x554C4154; /* "ULAT" */
  *reg32(kSIM_UIDML) = 0x4F520001;
  *reg32(kSIM_UIDL)  = 0x00000001;

  /* CCIF set = "flash controller idle", so the firmware's wait loops exit. */
  *reg8(kFTFL_FSTAT) = 0x80;

  g_map_status = 0;
}

}  // namespace

/* ------------------------------------------------------------ sinks */

extern "C" {

void okemu_set_stream_sink(okemu_stream_sink fn, void *ctx) {
  std::lock_guard<std::mutex> lk(g.mu); g.stream_sink = fn; g.stream_ctx = ctx;
}
void okemu_set_led_sink(okemu_led_sink fn, void *ctx) {
  std::lock_guard<std::mutex> lk(g.mu); g.led_sink = fn; g.led_ctx = ctx;
}

/* One funnel for every interface and direction. Snapshots the sink under the
 * lock, then calls it unlocked - the sink hops to the JS thread and must not
 * run with the HAL mutex held. */
static void stream_emit(const uint8_t *data, size_t len, int iface, int dir) {
  okemu_stream_sink fn; void *ctx;
  {
    std::lock_guard<std::mutex> lk(g.mu);
    fn = g.stream_sink; ctx = g.stream_ctx;
  }
  if (fn) fn(data, len, iface, dir, ctx);
}

/* --------------------------------------------------------- lifecycle */

int okemu_hal_init(const char *storage_dir, char *err, size_t errlen) {
  g.dir = storage_dir ? storage_dir : ".";
  mkdir(g.dir.c_str(), 0700);

  /* 1. peripheral windows ---------------------------------------------
   * Already done by okemu_map_peripherals() during module load; here we only
   * surface a failure, since by now the firmware's static initializers have
   * run against whatever was (or wasn't) mapped. */
  if (g_map_status != 0) {
    snprintf(err, errlen, "%s", g_map_error);
    return -1;
  }

  /* 2. flash array, file-backed at its real address -------------------
   *
   * The firmware reads its own storage through raw pointers, and fw_hash()
   * walks from fwstartadr (0x6060). Mapping from 0 needs mmap_min_addr to be
   * lowered (or CAP_SYS_RAWIO). If we cannot, we still map everything from
   * mmap_min_addr up - which covers the whole storage area at 0x3A800 - and
   * mark the device as already provisioned so the one-time block that calls
   * fw_hash() never runs.
   */
  char e2[256];
  g.flash_fd = open_backing(g.dir, "flash.bin", OKEMU_FLASH_SIZE, 0xFF, e2, sizeof e2);
  if (g.flash_fd < 0) { snprintf(err, errlen, "%s", e2); return -1; }

  /*
   * mmap() treats addr==0 as "no hint" and picks an address of its own, even
   * with MAP_FIXED_NOREPLACE - so a request for base 0 can "succeed" somewhere
   * else entirely. Every mapping below is therefore checked against the
   * address we asked for, and anything else is unmapped and treated as a
   * failure.
   */
  bool low_mapped = true;
  size_t off = 0;
  void *fp = mmap((void *)OKEMU_FLASH_BASE, OKEMU_FLASH_SIZE,
                  PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED_NOREPLACE,
                  g.flash_fd, 0);
  if (fp != MAP_FAILED && (uintptr_t)fp != OKEMU_FLASH_BASE) {
    munmap(fp, OKEMU_FLASH_SIZE);
    fp = MAP_FAILED;
  }
  if (fp == MAP_FAILED) {
    /*
     * vm.mmap_min_addr blocks the bottom of the address space, so walk up
     * until something sticks. How far we get decides what works:
     *
     *   0x0000  everything, including fw_hash()'s walk from fwstartadr.
     *   0x1000  enough for real use. The firmware's own key material lives
     *           here - certified_hw is enckeysectoradr+432 = 0x5BB0 - and
     *           okcrypto_split_sundae() dereferences it on EVERY AES-GCM
     *           operation, so without this the device segfaults the moment it
     *           encrypts anything (e.g. storing a PIN). 4096 is the useful
     *           setting: it still leaves page 0 unmapped, so genuine NULL
     *           dereferences fault exactly as they should.
     *   0x10000 the unprivileged default. Storage at 0x3A800 is reachable and
     *           the device boots, but any crypto that touches certified_hw
     *           will crash. Usable only for HID/protocol work.
     */
    static const size_t kFallbacks[] = { 0x1000, 0x10000 };
    for (size_t i = 0; i < sizeof kFallbacks / sizeof *kFallbacks; i++) {
      off = kFallbacks[i];
      fp = mmap((void *)(OKEMU_FLASH_BASE + off), OKEMU_FLASH_SIZE - off,
                PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED_NOREPLACE,
                g.flash_fd, (off_t)off);
      if (fp != MAP_FAILED && (uintptr_t)fp == OKEMU_FLASH_BASE + off) break;
      if (fp != MAP_FAILED) { munmap(fp, OKEMU_FLASH_SIZE - off); fp = MAP_FAILED; }
    }
    if (fp == MAP_FAILED) {
      snprintf(err, errlen,
               "cannot map flash: %s - lower vm.mmap_min_addr "
               "(sudo sysctl -w vm.mmap_min_addr=4096)", strerror(errno));
      return -1;
    }
    low_mapped = false;

    if (off > 0x5BB0UL) {
      fprintf(stderr,
              "[okemu] WARNING: flash mapped from %#lx; the firmware's key "
              "material at 0x5BB0 (certified_hw) is NOT mapped.\n"
              "[okemu]          Crypto operations will crash. Run "
              "scripts/setup-permissions.sh, or:\n"
              "[okemu]          sudo sysctl -w vm.mmap_min_addr=4096\n",
              (unsigned long)off);
    }
  }
  g.flash = (uint8_t *)OKEMU_FLASH_BASE;
  g.flash_mapped_off = off;

  /* 3. EEPROM --------------------------------------------------------- */
  g.eeprom_fd = open_backing(g.dir, "eeprom.bin", OKEMU_EEPROM_SIZE, 0xFF, e2, sizeof e2);
  if (g.eeprom_fd < 0) { snprintf(err, errlen, "%s", e2); return -1; }
  if (pread(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0) != OKEMU_EEPROM_SIZE)
    memset(g.eeprom, 0xFF, OKEMU_EEPROM_SIZE);

  /*
   * FSEC != 0x44 sends the firmware through its one-time provisioning path
   * (device-key derivation + fw_hash + lock). That path is only safe when the
   * whole flash array including fwstartadr (0x6060) is mapped.
   */
  *(volatile uint8_t *)kFTFL_FSEC = low_mapped ? 0xFF : 0x44;

  okemu_time_start();
  return 0;
}

void okemu_hal_shutdown(void) {
  if (g.eeprom_fd >= 0) {
    pwrite(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0);
    ::close(g.eeprom_fd);
    g.eeprom_fd = -1;
  }
  if (g.flash) {
    msync((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
          OKEMU_FLASH_SIZE - g.flash_mapped_off, MS_SYNC);
  }
  if (g.flash_fd >= 0) { ::close(g.flash_fd); g.flash_fd = -1; }
}

void okemu_factory_reset(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.flash) {
    memset((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off), 0xFF,
           OKEMU_FLASH_SIZE - g.flash_mapped_off);
    msync((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
          OKEMU_FLASH_SIZE - g.flash_mapped_off, MS_SYNC);
  }
  memset(g.eeprom, 0xFF, OKEMU_EEPROM_SIZE);
  if (g.eeprom_fd >= 0) pwrite(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0);
  g.restart = true;
}

int  okemu_restart_requested(void) { std::lock_guard<std::mutex> lk(g.mu); return g.restart; }
void okemu_clear_restart(void)     { std::lock_guard<std::mutex> lk(g.mu); g.restart = false; }
void okemu_request_restart(void)   { std::lock_guard<std::mutex> lk(g.mu); g.restart = true; }

/* -------------------------------------------------------------- time */

void okemu_time_start(void) { g.t0_us = now_us(); }

uint32_t okemu_micros(void) { return (uint32_t)(now_us() - g.t0_us); }

void okemu_delay_ms(uint32_t ms) {
  struct timespec ts;
  ts.tv_sec  = ms / 1000;
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  nanosleep(&ts, nullptr);
  okemu_sync_systick();
}

/* ----------------------------------------------------------- buttons */

void okemu_set_button(int n, int down) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  g.button[n] = down != 0;
}

int okemu_get_button(int n) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return 0;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.button[n] ? 1 : 0;
}

/*
 * setup() assigns TOUCHPIN1..6 = pins 1, 22, 23, 17, 15, 16. The firmware
 * baselines each pad at rest and treats a large positive excursion as a touch,
 * so we report a low idle value and a high one while the button is held.
 */
int okemu_touch_for_pin(uint8_t pin) {
  static const uint8_t kPinForButton[OKEMU_NUM_BUTTONS] = { 1, 22, 23, 17, 15, 16 };
  for (int i = 0; i < OKEMU_NUM_BUTTONS; i++) {
    if (kPinForButton[i] == pin)
      return okemu_get_button(i + 1) ? 6000 : 1000;
  }
  return 1000;
}

/* --------------------------------------------------------------- LED */

void okemu_led_set(int index, uint8_t r, uint8_t g_, uint8_t b) {
  if (index < 0 || index >= OKEMU_NUM_PIXELS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  g.px[index].r = r; g.px[index].g = g_; g.px[index].b = b;
}

void okemu_led_show(void) {
  okemu_led_sink fn; void *ctx; okemu_rgb snap[OKEMU_NUM_PIXELS];
  {
    std::lock_guard<std::mutex> lk(g.mu);
    fn = g.led_sink; ctx = g.led_ctx;
    memcpy(snap, g.px, sizeof snap);
  }
  if (fn) fn(snap, OKEMU_NUM_PIXELS, ctx);
}

/* ------------------------------------------------------------ RawHID */

int okemu_hid_deliver(const uint8_t *data, size_t len, int iface) {
  if (iface == OKEMU_IFACE_SEREMU) {
    /* Debug console input: bytes, not 64-byte reports. */
    {
      std::lock_guard<std::mutex> lk(g.mu);
      for (size_t i = 0; i < len; i++) g.seremu_in.push_back(data[i]);
    }
    stream_emit(data, len, OKEMU_IFACE_SEREMU, OKEMU_DIR_IN);
    return 0;
  }
  if (iface != OKEMU_IFACE_FIDO && iface != OKEMU_IFACE_VENDOR)
    return -1;   /* keyboard is device -> host only */

  Hal::InPkt pkt;
  pkt.iface = iface;
  pkt.data.assign(64, 0);
  memcpy(pkt.data.data(), data, len < 64 ? len : 64);

  /*
   * Snapshot before handing the packet to the queue: push_back(std::move(pkt))
   * leaves pkt.data empty, so reading pkt.data.data() afterwards dereferences
   * null and takes the process down. Every inbound RawHID report hit this.
   */
  uint8_t snap[64];
  memcpy(snap, pkt.data.data(), 64);

  {
    std::lock_guard<std::mutex> lk(g.mu);
    g.hid_in.push_back(std::move(pkt));
  }
  g.hid_cv.notify_one();
  stream_emit(snap, sizeof snap, iface, OKEMU_DIR_IN);
  return 0;
}

/*
 * Mirrors OnlyKey-Firmware/usb_rawhid.c: drain the FIDO endpoint first, then
 * the vendor one, and return WHICH interface produced the packet. Returning a
 * byte count here would make the firmware reply on the wrong interface.
 */
int okemu_hid_recv(void *buf, uint32_t timeout) {
  std::unique_lock<std::mutex> lk(g.mu);
  if (g.hid_in.empty()) {
    if (timeout == 0) return 0;
    g.hid_cv.wait_for(lk, std::chrono::milliseconds(timeout),
                      [] { return !g.hid_in.empty(); });
    if (g.hid_in.empty()) return 0;
  }
  /* Prefer a FIDO packet if one is queued, matching the endpoint poll order. */
  auto it = g.hid_in.begin();
  for (auto i = g.hid_in.begin(); i != g.hid_in.end(); ++i) {
    if (i->iface == OKEMU_IFACE_FIDO) { it = i; break; }
  }
  memcpy(buf, it->data.data(), 64);
  int iface = it->iface;
  g.hid_in.erase(it);
  return iface;
}

int okemu_hid_pending(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  int n = 0;
  for (const auto &p : g.hid_in)
    if (p.iface == OKEMU_IFACE_FIDO) n += 64;
  return n;
}

int okemu_hid_emit(const uint8_t *data, size_t len, uint32_t /*timeout*/, int iface) {
  stream_emit(data, len, iface, OKEMU_DIR_OUT);
  return (int)len;
}

/* ---------------------------------------------------------- keyboard */

void okemu_kbd_emit(const uint8_t *report8) {
  stream_emit(report8, 8, OKEMU_IFACE_KEYBOARD, OKEMU_DIR_OUT);
}

/* --------------------------------------------------------------- log */

void okemu_log(const uint8_t *data, size_t len) {
  stream_emit(data, len, OKEMU_IFACE_SEREMU, OKEMU_DIR_OUT);
}

/* --- SEREMU input, backing Serial.read() on the firmware side --- */

int okemu_seremu_getc(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.seremu_in.empty()) return -1;
  int c = g.seremu_in.front();
  g.seremu_in.pop_front();
  return c;
}

int okemu_seremu_peek(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return g.seremu_in.empty() ? -1 : g.seremu_in.front();
}

int okemu_seremu_avail(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return (int)g.seremu_in.size();
}

void okemu_seremu_flush_in(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  g.seremu_in.clear();
}

/* EEPROM backing, used by the eeprom override. */
uint8_t okemu_eeprom_read(uint32_t addr) {
  if (addr >= OKEMU_EEPROM_SIZE) return 0xFF;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.eeprom[addr];
}

void okemu_eeprom_write(uint32_t addr, uint8_t v) {
  if (addr >= OKEMU_EEPROM_SIZE) return;
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.eeprom[addr] == v) return;
  g.eeprom[addr] = v;
  if (g.eeprom_fd >= 0) pwrite(g.eeprom_fd, &v, 1, (off_t)addr);
}

/* ----------------------------------------------------------- entropy */

void okemu_random_bytes(uint8_t *out, size_t len) {
  static int fd = -1;
  if (fd < 0) fd = ::open("/dev/urandom", O_RDONLY);
  if (fd >= 0) {
    size_t got = 0;
    while (got < len) {
      ssize_t n = ::read(fd, out + got, len - got);
      if (n <= 0) break;
      got += (size_t)n;
    }
    if (got == len) return;
  }
  /* /dev/urandom is effectively always available; this only guards against a
   * pathological fd exhaustion so the caller still gets varying bytes. */
  for (size_t i = 0; i < len; i++)
    out[i] = (uint8_t)(now_us() >> ((i % 8) * 8));
}

}  // extern "C"
