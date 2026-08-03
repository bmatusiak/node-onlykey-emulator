/*
 * hid-descriptors.js - the four HID interfaces, exactly as real hardware
 * presents them.
 *
 * Single source of truth for both transports: the UHID bridge builds
 * UHID_CREATE2 from these, and the USB-gadget setup writes the same bytes into
 * configfs. They are byte-identical to scripts/emulate-onlykey-hid.sh, which
 * was captured from a physical OnlyKey.
 *
 * Interface numbers are usb_desc.h's, and the order here IS the order the
 * gadget instantiates its functions - hid.usb0 becomes bInterfaceNumber 0 and
 * so on - so this array must stay in interface order.
 */
'use strict';

const IFACE = { KEYBOARD: 0, FIDO: 1, VENDOR: 2, SEREMU: 3 };

/* 1D50:60FC is the OpenMoko-allocated pair the shipping firmware uses. */
const VENDOR_ID = 0x1d50;
const PRODUCT_ID = 0x60fc;
const MANUFACTURER = 'CRYPTOTRUST';
const PRODUCT_NAME = 'ONLYKEY';
const SERIAL_NUMBER = '1000000000';

const KEYBOARD_DESC = Buffer.from([
  0x05, 0x01,        // Usage Page (Generic Desktop)
  0x09, 0x06,        // Usage (Keyboard)
  0xA1, 0x01,        // Collection (Application)
  0x05, 0x07,        //   Usage Page (Key Codes)
  0x19, 0xE0, 0x29, 0xE7,
  0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08,
  0x81, 0x02,        //   Input - modifier byte
  0x95, 0x01, 0x75, 0x08,
  0x05, 0x0C, 0x09, 0xB8,
  0x81, 0x01,        //   Input - media keys
  0x95, 0x05, 0x75, 0x01,
  0x05, 0x08, 0x19, 0x01, 0x29, 0x05,
  0x91, 0x02,        //   Output - LED report
  0x95, 0x01, 0x75, 0x03,
  0x91, 0x01,        //   Output - LED padding
  0x95, 0x06, 0x75, 0x08,
  0x15, 0x00, 0x25, 0x7F,
  0x05, 0x07, 0x19, 0x00, 0x29, 0x7F,
  0x81, 0x00,        //   Input - 6 keycodes
  /*
   * 8-byte Feature report. Not decoration: OnlyKey's usb_dev.c uses SET_REPORT
   * on this interface as a side channel, filling setBuffer[] which
   * process_setreport() then consumes. The OnlyKey app sends configuration
   * this way. Omitting it makes the host unable to send those packets at all.
   */
  0x09, 0x76, 0x95, 0x08, 0x75, 0x08, 0xB1, 0x02,
  0xC0,
]);

function rawhidDesc(usagePage, usage) {
  return Buffer.from([
    0x06, usagePage & 0xFF, (usagePage >> 8) & 0xFF,
    0x09, usage,
    0xA1, 0x01,                    // Collection (Application)
    0x09, 0x20,                    //   Usage (input data)
    0x15, 0x00, 0x26, 0xFF, 0x00,
    0x75, 0x08, 0x95, 0x40,        //   64 bytes
    0x81, 0x02,                    //   Input
    0x09, 0x21,                    //   Usage (output data)
    0x15, 0x00, 0x26, 0xFF, 0x00,
    0x75, 0x08, 0x95, 0x40,        //   64 bytes
    0x91, 0x02,                    //   Output
    0xC0,
  ]);
}

const SEREMU_DESC = Buffer.from([
  0x06, 0xC9, 0xFF,  // Usage Page 0xFFC9
  0x09, 0x04,        // Usage 0x04
  0xA1, 0x5C,        // Collection 0x5C
  0x75, 0x08,
  0x15, 0x00, 0x26, 0xFF, 0x00,
  0x95, 64,          // SEREMU_TX_SIZE
  0x09, 0x75, 0x81, 0x02,   // Input
  0x95, 32,          // SEREMU_RX_SIZE
  0x09, 0x76, 0x91, 0x02,   // Output
  0x95, 0x04,
  0x09, 0x76, 0xB1, 0x02,   // Feature
  0xC0,
]);

/*
 * inSize/outSize differ on SEREMU (64 in, 32 out) - the report descriptor says
 * so, and getting it wrong overruns hidraw. `protocol`/`subclass` are the USB
 * HID class fields: only the keyboard is a boot-protocol device.
 */
const INTERFACES = [
  { iface: IFACE.KEYBOARD, name: 'keyboard', desc: KEYBOARD_DESC,
    inSize: 8,  outSize: 8,  writable: false, protocol: 1, subclass: 1 },
  { iface: IFACE.FIDO, name: 'fido', desc: rawhidDesc(0xF1D0, 0x01),
    inSize: 64, outSize: 64, writable: true,  protocol: 0, subclass: 0 },
  { iface: IFACE.VENDOR, name: 'vendor', desc: rawhidDesc(0xFFAB, 0x02),
    inSize: 64, outSize: 64, writable: true,  protocol: 0, subclass: 0 },
  { iface: IFACE.SEREMU, name: 'seremu', desc: SEREMU_DESC,
    inSize: 64, outSize: 32, writable: true,  protocol: 0, subclass: 0 },
];

module.exports = {
  IFACE, INTERFACES,
  VENDOR_ID, PRODUCT_ID, MANUFACTURER, PRODUCT_NAME, SERIAL_NUMBER,
  KEYBOARD_DESC, SEREMU_DESC, rawhidDesc,
};
