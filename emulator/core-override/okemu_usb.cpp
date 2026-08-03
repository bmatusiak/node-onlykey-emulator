/*
 * okemu_usb.cpp - host replacement for the teensy3 USB stack
 * (usb_dev.c, usb_rawhid.c, usb_keyboard.c, usb_seremu.c).
 *
 * OnlyKey enumerates as a composite device: Keyboard(0), RawHID(1),
 * RawHID2(2), SEREMU(3) - see OnlyKey-Firmware/usb_desc.h. The firmware only
 * ever reaches the wire through a handful of entry points, and each maps
 * cleanly onto the HAL:
 *
 *   RawHID / RawHID2  <-> the UHID bridge in JS (the FIDO + OnlyKey protocol)
 *   Keyboard          <-> 8-byte HID keyboard reports, surfaced to the UI
 *   SEREMU (Serial)   <-> the debug log
 *
 * The class wrappers in the core headers are inline and call the C functions
 * below, so defining these is enough to satisfy `Keyboard`, `RawHID`, `Serial`.
 */
#include <stdint.h>
#include <string.h>

#include "usb_dev.h"
#include "usb_rawhid.h"
#include "usb_keyboard.h"
#include "usb_seremu.h"
#include "ok_hal.h"

extern "C" {

/* Non-zero means "host has configured us"; the firmware gates transmits on
 * this, so the emulated device is always enumerated. */
volatile uint8_t usb_configuration = 1;

void usb_init(void) {}
void usb_isr(void) {}

/* ------------------------------------------------------------ RawHID */

int usb_rawhid_recv(void *buffer, uint32_t timeout) {
  return okemu_hid_recv(buffer, timeout);
}

int usb_rawhid_available(void) {
  /* A 0-timeout probe would consume the packet, so report the queue depth via
   * a peek instead. okemu_hid_recv() is the only consumer. */
  return okemu_hid_pending();
}

/*
 * usb_dev.c's wipe_usb_buffer() walks the endpoint BDTs and usb_free()s every
 * packet still queued on every endpoint. The firmware calls it once, at the end
 * of the successful-unlock path in payload(), to throw away host traffic that
 * arrived while the device was still locked ("Wipe old responses") so it is not
 * then processed as though it had been sent by an authorised caller.
 *
 * Here the equivalent is simply to drop the queued inbound reports. Both the
 * RawHID queue and the SEREMU byte queue are cleared, matching the hardware,
 * where those are endpoint packet queues like any other.
 *
 * This was the last unresolved firmware symbol in the module, and because ELF
 * binds lazily it did not fail at load time - it killed the process the first
 * time a PIN was ever accepted, with a bare `symbol lookup error`. It stayed
 * hidden while millis() was frozen (see okemu_systick_start), because the wait
 * loop immediately above this call never terminated to reach it.
 */
void wipe_usb_buffer(void) {
  okemu_hid_flush_in();
  okemu_seremu_flush_in();
}

int usb_rawhid_send(const void *buffer, uint32_t timeout) {
  return okemu_hid_emit((const uint8_t *)buffer, 64, timeout, OKEMU_IFACE_FIDO);
}

int usb_rawhid_send2(const void *buffer, uint32_t timeout) {
  return okemu_hid_emit((const uint8_t *)buffer, 64, timeout, OKEMU_IFACE_VENDOR);
}

/* ---------------------------------------------------------- keyboard */

uint8_t keyboard_modifier_keys = 0;
uint8_t keyboard_media_keys    = 0;
uint8_t keyboard_keys[6]       = { 0, 0, 0, 0, 0, 0 };
uint8_t keyboard_protocol      = 1;
uint8_t keyboard_idle_config   = 125;
uint8_t keyboard_idle_count    = 0;
volatile uint8_t keyboard_leds = 0;

/*
 * Emits the current key state as a standard boot-protocol report, then - so a
 * viewer sees discrete keystrokes rather than a stuck key - the matching
 * release. The firmware calls send_now() once per keystroke.
 */
int usb_keyboard_send(void) {
  uint8_t report[8];
  report[0] = keyboard_modifier_keys;
  report[1] = 0;
  memcpy(report + 2, keyboard_keys, 6);
  okemu_kbd_emit(report);
  return 0;
}

int usb_keyboard_press(uint8_t key, uint8_t modifier) {
  keyboard_modifier_keys = modifier;
  keyboard_keys[0] = key;
  usb_keyboard_send();
  keyboard_modifier_keys = 0;
  keyboard_keys[0] = 0;
  usb_keyboard_send();
  return 0;
}

void usb_keyboard_press_keycode(uint16_t n) {
  keyboard_keys[0] = (uint8_t)n;
  usb_keyboard_send();
}

void usb_keyboard_release_keycode(uint16_t n) {
  (void)n;
  keyboard_keys[0] = 0;
  usb_keyboard_send();
}

void usb_keyboard_release_all(void) {
  keyboard_modifier_keys = 0;
  keyboard_media_keys = 0;
  memset(keyboard_keys, 0, sizeof keyboard_keys);
  usb_keyboard_send();
}

void usb_keyboard_write(uint8_t c) {
  usb_keyboard_write_unicode(c);
}

/*
 * The real core maps a code point through keylayouts.h to keycode+modifier.
 * The emulator's consumer is a human-readable log and the UHID keyboard
 * interface, so pass the character through as an ASCII payload and let the JS
 * side render it; a full layout reverse-map would add no fidelity here.
 */
void usb_keyboard_write_unicode(uint16_t cpoint) {
  uint8_t report[8] = { 0 };
  report[1] = 0xFF;                 /* marker: literal character, not a keycode */
  report[2] = (uint8_t)cpoint;
  report[3] = (uint8_t)(cpoint >> 8);
  okemu_kbd_emit(report);
}

/* ------------------------------- keyboard SET_REPORT / GET_REPORT --------
 *
 * OnlyKey uses HID control transfers on the keyboard interface as a second
 * data channel - this is the Yubikey OTP / HMAC-SHA1 personalization protocol
 * (see libraries/ykcore, yksim), which is how the OnlyKey app and
 * yubikey-personalization talk to the device.
 *
 * On hardware this lives in usb_dev.c's usb_setup():
 *   SET_REPORT (0x0921) points ep0_rx_ptr at setBuffer and takes 8 bytes;
 *   GET_REPORT (0x01a1) runs the state machine below and returns 8 bytes.
 *
 * usb_dev.c is a Kinetis USB peripheral driver and cannot be compiled here, so
 * the two control-transfer handlers are ported. Everything they touch -
 * setBuffer, getBuffer, keyboard_buffer, sess_counter, may_block - is defined
 * by okcore.cpp and shared, so device state stays in one place.
 *
 * Kept deliberately close to the original, including the ordering of the
 * branches: the sequence is what the host driver expects.
 */

extern uint8_t setBuffer[9];
extern uint8_t getBuffer[9];
extern uint8_t keyboard_buffer[];
extern uint8_t sess_counter;
extern uint8_t may_block;

/* Host -> device. Mirrors `ep0_rx_ptr = setBuffer; ep0_rx_len = 8;`. */
void okemu_kbd_set_report(const uint8_t *data, uint32_t len) {
  const uint32_t n = len < 8 ? len : 8;
  memcpy(setBuffer, data, n);
}

/*
 * Device -> host. Fills `out` with the 8-byte report and returns its length.
 * Port of usb_dev.c case 0x01a1.
 */
int okemu_kbd_get_report(uint8_t *out) {
  const uint8_t *data = getBuffer;
  int i;

  if (setBuffer[7] >= 0x80 && setBuffer[7] <= 0x89) {
    for (i = 0; i < 7; i++) {
      keyboard_buffer[i + ((setBuffer[7] - 0x80) * 7)] = setBuffer[i];
    }
  }

  /* Reset / Done / ACK - operation complete. */
  if (setBuffer[7] == 0x8f || (setBuffer[7] < 0x89 && setBuffer[7] > 0x80)) {
    getBuffer[1] = 0x02;
    getBuffer[2] = 0x02;
    getBuffer[3] = 0x03;
    getBuffer[4] = sess_counter;
    getBuffer[5] = 0x03;
    getBuffer[6] = may_block;
    getBuffer[7] = 0x00;
    getBuffer[8] = 0x00;
    if (setBuffer[7] == 0x8f) {
      for (i = 0; i < 80; i++) keyboard_buffer[i] = 0;
    }
    setBuffer[7] = 0;
  }
  /* Get serial number (yubikey-personalization ykcore.c). */
  else if (setBuffer[1] == 0x10 && setBuffer[2] == 0x6b && setBuffer[3] == 0x5b) {
    getBuffer[1] = 0x10;
    getBuffer[2] = 0xbf;
    getBuffer[3] = 0x91;
    getBuffer[4] = 0xed;
    getBuffer[5] = 0x45;
    getBuffer[6] = 0x00;
    getBuffer[7] = 0xc0;
    setBuffer[7] = 0;
  }
  else if (getBuffer[7] >= 0xa1) {   /* waiting for button press */
    if (getBuffer[8] == 0x43 || getBuffer[8] == 0xA9) {
      getBuffer[8]++;
      data = keyboard_buffer;        /* send second C0 */
      getBuffer[1] = 0x02;
      getBuffer[2] = 0x02;
      getBuffer[3] = 0x03;
      getBuffer[4] = sess_counter;
      getBuffer[5] = 0x03;
      getBuffer[6] = may_block;
      getBuffer[7] = 0x00;
      getBuffer[8] = 0x00;
      setBuffer[7] = 0x8f;
    } else if (getBuffer[8]) {       /* already sent the first C0 */
      getBuffer[8]++;
      data = keyboard_buffer + ((getBuffer[8] & 0x0F) * 8);
    } else if (keyboard_buffer[79] == 0xC9) {
      getBuffer[8] = 0xA0;           /* 10 messages to send */
      data = keyboard_buffer;
    } else if (keyboard_buffer[31] == 0xC3) {
      getBuffer[8] = 0x40;           /* 4 messages to send */
      data = keyboard_buffer;
    }
  }
  else if (setBuffer[7] == 0x89 && (getBuffer[6] == 0x05 || getBuffer[6] == 0x07)) {
    getBuffer[7] = 0x89;
    setBuffer[8] = 1;                /* hands off to process_setreport() */
  }

  memcpy(out, data, 8);
  return 8;
}

/* ------------------------------------------------------- SEREMU/debug */

volatile uint8_t usb_seremu_transmit_flush_timer = 0;

/*
 * SEREMU output is buffered into whole packets before it leaves the device,
 * exactly as the Teensy core does.
 *
 * The firmware prints a character at a time (printHex(), Serial.print of an
 * int), so putchar() is called once per byte. Emitting a HID report per call
 * meant a 1-byte payload padded to a 64-byte report per CHARACTER: hidraw's
 * per-reader ring buffer overflowed and the kernel silently dropped reports,
 * so readers saw shredded, partial text - "Enter PIN" vanished while the
 * surrounding hex dump survived. On hardware usb_seremu_putchar() fills a
 * packet and only transmits when it is full or the flush timer fires
 * (SEREMU_TX_INTERVAL), which is what keeps the rate sane.
 *
 * Flush on a full packet or at end of line; the line boundary keeps
 * interactive output prompt rather than waiting for 64 bytes to accumulate.
 */
static uint8_t  s_tx[SEREMU_TX_SIZE];
static uint32_t s_tx_len = 0;

static void seremu_flush(void) {
  if (!s_tx_len) return;
  okemu_log(s_tx, s_tx_len);
  s_tx_len = 0;
}

int usb_seremu_putchar(uint8_t c) {
  s_tx[s_tx_len++] = c;
  if (s_tx_len >= sizeof(s_tx) || c == '\n') seremu_flush();
  return 1;
}

int usb_seremu_write(const void *buffer, uint32_t size) {
  const uint8_t *p = (const uint8_t *)buffer;
  for (uint32_t i = 0; i < size; i++) usb_seremu_putchar(p[i]);
  return (int)size;
}

int  usb_seremu_getchar(void)          { return okemu_seremu_getc(); }
int  usb_seremu_peekchar(void)         { return okemu_seremu_peek(); }
int  usb_seremu_available(void)        { return okemu_seremu_avail(); }
void usb_seremu_flush_input(void)      { okemu_seremu_flush_in(); }
int  usb_seremu_write_buffer_free(void){ return 63; }
void usb_seremu_flush_output(void)     { seremu_flush(); }
void usb_seremu_flush_callback(void)   {}

}  // extern "C"
