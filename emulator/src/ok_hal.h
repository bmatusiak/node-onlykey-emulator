/*
 * ok_hal.h - the emulator's hardware abstraction layer.
 *
 * This is the boundary between the untouched OnlyKey firmware and the Node
 * addon. The firmware compiles verbatim against the real Teensyduino headers;
 * the peripherals it reaches for are backed here instead of by silicon.
 *
 * The central trick: hal_init() mmaps the Kinetis peripheral windows and the
 * 256 KB flash array at their *real* MK20DX256 addresses. Every
 * `*(volatile uint32_t *)0x40020000` in the firmware then lands in ordinary
 * process memory rather than faulting, so kinetis.h needs no shimming at all.
 * The flash mapping is file-backed and MAP_SHARED, which makes the firmware's
 * direct `*(unsigned int *)adr` reads of its own storage work verbatim and
 * gives persistence for free.
 */
#ifndef OK_HAL_H
#define OK_HAL_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------- layout */

#define OKEMU_FLASH_BASE   0x00000000UL
#define OKEMU_FLASH_SIZE   0x00040000UL   /* 256 KB - MK20DX256 */
#define OKEMU_EEPROM_SIZE  2048           /* Teensy 3.1 emulated EEPROM     */

/* MK20DX256 has 6 touch-sensed buttons; firmware numbers them 1..6. */
#define OKEMU_NUM_BUTTONS  6
/* OnlyKey Color drives 2 NeoPixels. */
#define OKEMU_NUM_PIXELS   2

typedef struct { uint8_t r, g, b; } okemu_rgb;

/* --------------------------------------------------------------- sinks
 * Registered by the addon. Called on the firmware thread, so each one must
 * hand off to libuv rather than touch a JS value directly.
 */
typedef void (*okemu_bytes_sink)(const uint8_t *data, size_t len,
                                 int channel, void *ctx);
typedef void (*okemu_led_sink)(const okemu_rgb *px, int count, void *ctx);

typedef void (*okemu_event_sink)(void *ctx);

#define OKEMU_DIR_OUT  0   /* device -> host */
#define OKEMU_DIR_IN   1   /* host -> device */

/*
 * Every packet on every interface, both directions, through one sink - so JS
 * gets a complete bus trace it can demux by (iface, dir) rather than a set of
 * disconnected callbacks. The UI's debug log is exactly this stream.
 */
typedef void (*okemu_stream_sink)(const uint8_t *data, size_t len,
                                  int iface, int dir, void *ctx);

void okemu_set_stream_sink(okemu_stream_sink fn, void *ctx);
void okemu_set_led_sink(okemu_led_sink fn, void *ctx);
/* Fires when the firmware asks to reboot; see okemu_restart.cpp. */
void okemu_set_restart_sink(okemu_event_sink fn, void *ctx);

/* ----------------------------------------------------------- lifecycle */

/*
 * Maps the peripheral + flash windows and opens the backing store under
 * `storage_dir`. Returns 0 on success; on failure fills `err` and returns -1.
 * Must be called before any firmware code runs.
 */
int  okemu_hal_init(const char *storage_dir, char *err, size_t errlen);
void okemu_hal_shutdown(void);

/* Wipes flash + EEPROM back to erased state (0xFF) - a factory reset. */
void okemu_factory_reset(void);

/* True once the firmware has asked for a reboot via CPU_RESTART(). */
int  okemu_restart_requested(void);
void okemu_clear_restart(void);
void okemu_request_restart(void);

/*
 * Runs the firmware: setup() then loop() forever, on the calling thread.
 *
 * Returns only when the firmware executes CPU_RESTART() - a write to the
 * Cortex-M AIRCR register. That write is inert against plain memory and the
 * firmware never expects to run past it, so the register's page is mapped
 * read-only and the resulting fault parks this thread instead.
 *
 * The restart sink fires on the way out; deciding what a reboot means (respawn
 * the process, rebuild the addon, or nothing) belongs to JS. Flash and EEPROM
 * are file-backed, so device state survives a respawn untouched - a reboot is
 * not a factory reset.
 */
void okemu_firmware_run(void);

/* --------------------------------------------------------------- time */

void     okemu_time_start(void);
uint32_t okemu_micros(void);
void     okemu_delay_ms(uint32_t ms);
/* Republishes the host clock into the core's systick_millis_count, which
 * Teensy's millis() reads inline. Monotonic: safe to call from both the
 * SysTick thread and the firmware thread. */
void     okemu_sync_systick(void);

/* Stands in for the SysTick interrupt: keeps systick_millis_count advancing
 * on its own, so millis() moves even in loops that never call micros().
 * The firmware has such a loop on the unlock path. */
void     okemu_systick_start(void);
void     okemu_systick_stop(void);

/* ------------------------------------------------------------ buttons */

/* Firmware reads these through touchRead(); button n is 1..6. */
void okemu_set_button(int n, int down);
int  okemu_get_button(int n);
int  okemu_touch_for_pin(uint8_t pin);   /* pin -> simulated capacitance */

/* -------------------------------------------------------------- LED */

void okemu_led_set(int index, uint8_t r, uint8_t g, uint8_t b);
void okemu_led_show(void);               /* flush to the LED sink */

/* ------------------------------------------------------------ RawHID */

/*
 * Interface numbering is exactly OnlyKey-Firmware/usb_desc.h's, so it lines up
 * with the descriptors and with RAWHID_INTERFACE / SEREMU_INTERFACE:
 *
 *   0 = Keyboard  (boot keyboard)          device -> host only
 *   1 = RawHID    (FIDO,   page 0xF1D0)    bidirectional
 *   2 = RawHID2   (vendor, page 0xFFAB)    bidirectional
 *   3 = SEREMU    (debug serial)           bidirectional
 *
 * SEREMU exists only in DEBUG builds - production firmware enumerates 3
 * interfaces, not 4.
 */
#define OKEMU_IFACE_KEYBOARD  0
#define OKEMU_IFACE_FIDO      1
#define OKEMU_IFACE_VENDOR    2
#define OKEMU_IFACE_SEREMU    3

/*
 * host -> device, from JS. `iface` must be FIDO, VENDOR or SEREMU; the
 * keyboard interface is device->host only and is rejected. Returns 0 on
 * success, -1 if the interface cannot accept input.
 */
int  okemu_hid_deliver(const uint8_t *data, size_t len, int iface);
/* device -> host; `iface` is OKEMU_IFACE_FIDO or OKEMU_IFACE_VENDOR. */
int  okemu_hid_emit(const uint8_t *data, size_t len, uint32_t timeout, int iface);
/*
 * Firmware side of RawHID.recv(). Returns the interface the packet arrived on
 * (1 or 2), or 0 on timeout - NOT a byte count. The firmware routes its reply
 * using this value, so the distinction matters.
 */
int  okemu_hid_recv(void *buf, uint32_t timeout);
/* Drop every queued inbound report - backs wipe_usb_buffer(). */
void okemu_hid_flush_in(void);
/* Bytes waiting on the FIDO interface, for RawHID.available(). */
int  okemu_hid_pending(void);

/* ---------------------------------------------------------- keyboard */

void okemu_kbd_emit(const uint8_t *report8);

/*
 * HID control transfers on the keyboard interface - OnlyKey's Yubikey OTP /
 * HMAC-SHA1 channel. Implemented in okemu_usb.cpp as a port of usb_dev.c's
 * usb_setup() cases 0x0921 and 0x01a1.
 */
void okemu_kbd_set_report(const uint8_t *data, uint32_t len);
int  okemu_kbd_get_report(uint8_t *out8);   /* returns bytes written (8) */

/* ------------------------------------------- SEREMU (debug serial, iface 3)
 * Output is the firmware's Serial.print(). Input backs Serial.read(), so a
 * host can drive the debug console as well as watch it.
 */
void okemu_log(const uint8_t *data, size_t len);
int  okemu_seremu_getc(void);      /* -1 when empty */
int  okemu_seremu_peek(void);
int  okemu_seremu_avail(void);
void okemu_seremu_flush_in(void);

/* ---------------------------------------------------------- storage */

uint8_t okemu_eeprom_read(uint32_t addr);
void    okemu_eeprom_write(uint32_t addr, uint8_t v);

/* ---------------------------------------------------------- entropy
 * Backs both the floating-ADC entropy the firmware samples at startup and the
 * RNG library's hardware-entropy hook. Drawn from the OS CSPRNG so emulated
 * device keys are not predictable.
 */
void okemu_random_bytes(uint8_t *out, size_t len);

#ifdef __cplusplus
}
#endif
#endif /* OK_HAL_H */
