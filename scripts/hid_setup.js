/*
 * Node.js OnlyKey Emulator - UHID Setup Script with FIDO2/WebAuthn Support
 * 
 * Registers a Composite Virtual HID Device (Keyboard + FIDO HID Usage Page 0xF1D0).
 *
 * Usage: 
 *   1. Ensure kernel module is loaded: sudo modprobe uhid
 *   2. Run script with elevated privileges: sudo node scripts/hid_setup.js
 */

/*
// Connecting UHID setup to your C++ addon instance
const UHIDDevice = require('./scripts/hid_setup');
const onlykeyNative = require('./build/Release/onlykey_emulator');

const device = new UHIDDevice();
device.start();

device.on('fido-output', (data) => {
  // Pass raw incoming report to C++ firmware state machine
  const response = onlykeyNative.processHidReport(data);
  if (response) {
    // Send FIDO response back to browser
    device.sendFidoReport(response);
  }
});
*/

const fs = require('fs');
const EventEmitter = require('events');

// UHID Protocol Opcodes (from linux/uhid.h)
const UHID_CREATE2 = 11;
const UHID_INPUT2 = 12;
const UHID_OUTPUT = 6;
const UHID_START = 2;
const UHID_OPEN = 4;

// OnlyKey Composite HID Report Descriptor (Keyboard + FIDO Raw HID Interface)
const hidDescriptor = Buffer.from([
    // -------------------------------------------------------------
    // Interface 1: Standard Keyboard (Usage Page 0x01, Usage 0x06)
    // -------------------------------------------------------------
    0x05, 0x01,        // Usage Page (Generic Desktop Ctrls)
    0x09, 0x06,        // Usage (Keyboard)
    0xA1, 0x01,        // Collection (Application)
    0x05, 0x07,        //   Usage Page (Kbrd/Keypad)
    0x19, 0xE0,        //   Usage Minimum (0xE0 - LeftControl)
    0x29, 0xE7,        //   Usage Maximum (0xE7 - Right GUI)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x01,        //   Logical Maximum (1)
    0x75, 0x01,        //   Report Size (1)
    0x95, 0x08,        //   Report Count (8)
    0x81, 0x02,        //   Input (Data,Var,Abs) -> Modifier Byte
    0x95, 0x01,        //   Report Count (1)
    0x75, 0x08,        //   Report Size (8)
    0x81, 0x01,        //   Input (Const,Array,Abs) -> Reserved Byte
    0x95, 0x05,        //   Report Count (5)
    0x75, 0x01,        //   Report Size (1)
    0x05, 0x08,        //   Usage Page (LEDs)
    0x19, 0x01,        //   Usage Minimum (Num Lock)
    0x29, 0x05,        //   Usage Maximum (Kana)
    0x91, 0x02,        //   Output (Data,Var,Abs) -> LED Indicators
    0x95, 0x01,        //   Report Count (1)
    0x75, 0x03,        //   Report Size (3)
    0x91, 0x01,        //   Output (Const,Array,Abs) -> LED Padding
    0x95, 0x06,        //   Report Count (6)
    0x75, 0x08,        //   Report Size (8)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x7F,        //   Logical Maximum (127)
    0x05, 0x07,        //   Usage Page (Kbrd/Keypad)
    0x19, 0x00,        //   Usage Minimum (0)
    0x29, 0x7F,        //   Usage Maximum (127)
    0x81, 0x00,        //   Input (Data,Array,Abs) -> Keycode Array (6 bytes)
    0xC0,              // End Collection

    // -------------------------------------------------------------
    // Interface 2: FIDO / OnlyKey Raw HID (Usage Page 0xF1D0, Usage 0x01)
    // -------------------------------------------------------------
    0x06, 0xD0, 0xF1,  // Usage Page (FIDO Alliance 0xF1D0)
    0x09, 0x01,        // Usage (FIDO Raw HID Authentication Device)
    0xA1, 0x01,        // Collection (Application)
    0x09, 0x20,        //   Usage (FIDO Input Report Data)
    0x15, 0x00,        //   Logical Minimum (0)
    0x26, 0xFF, 0x00,  //   Logical Maximum (255)
    0x75, 0x08,        //   Report Size (8 bits)
    0x95, 0x40,        //   Report Count (64 bytes)
    0x81, 0x02,        //   Input (Data,Var,Abs)
    0x09, 0x21,        //   Usage (FIDO Output Report Data)
    0x15, 0x00,        //   Logical Minimum (0)
    0x26, 0xFF, 0x00,  //   Logical Maximum (255)
    0x75, 0x08,        //   Report Size (8 bits)
    0x95, 0x40,        //   Report Count (64 bytes)
    0x91, 0x02,        //   Output (Data,Var,Abs)
    0xC0               // End Collection
]);

class UHIDDevice extends EventEmitter {
    constructor() {
        super();
        this.fd = null;
        this.buffer = Buffer.alloc(4096);
    }

    start() {
        try {
            this.fd = fs.openSync('/dev/uhid', 'r+');
        } catch (err) {
            console.error('Error opening /dev/uhid. Ensure you run with root privileges (sudo modprobe uhid && sudo node ...):', err.message);
            process.exit(1);
        }

        this._registerDevice();
        this._listen();
    }

    _registerDevice() {
        // Fixed 276-byte C struct header required by UHID_CREATE2
        const header = Buffer.alloc(276);
        let offset = 0;

        header.writeUInt32LE(UHID_CREATE2, offset); offset += 4;
        header.write('OnlyKey Virtual Security Key', offset, 'utf8'); offset += 128;
        header.write('UHID', offset, 'utf8'); offset += 64;
        header.write('1000000000', offset, 'utf8'); offset += 64;
        header.writeUInt16LE(hidDescriptor.length, offset); offset += 2;
        header.writeUInt16LE(3, offset); offset += 2; // BUS_USB = 3
        header.writeUInt32LE(0x1D50, offset); offset += 4; // Vendor ID (OnlyKey)
        header.writeUInt32LE(0x60FC, offset); offset += 4; // Product ID (OnlyKey)
        header.writeUInt32LE(0, offset); offset += 4;      // Version
        header.writeUInt32LE(0, offset);                  // Country

        const registrationPayload = Buffer.concat([header, hidDescriptor]);
        fs.writeSync(this.fd, registrationPayload);
        console.log('[UHID] Registered virtual OnlyKey FIDO device with kernel.');
    }

    _listen() {
        fs.read(this.fd, this.buffer, 0, this.buffer.length, null, (err, bytesRead) => {
            if (err) {
                if (err.code === 'EBADF' || err.code === 'ENODEV') return;
                console.error('[UHID] Read error:', err);
                return;
            }

            if (bytesRead > 0) {
                this._parseUHIDEvent(this.buffer.subarray(0, bytesRead));
            }
            this._listen(); // Continue event loop polling
        });
    }

    _parseUHIDEvent(eventBuf) {
        const type = eventBuf.readUInt32LE(0);

        if (type === UHID_OUTPUT) {
            // Browser or OS sent a 64-byte FIDO / WebAuthn report packet
            // UHID_OUTPUT struct: type(4B) + data_buf(1024B) + size(2B) + rtype(1B)
            const rtype = eventBuf.readUInt8(4 + 1024 + 2);
            const size = eventBuf.readUInt16LE(4 + 1024);
            const data = eventBuf.subarray(4, 4 + size);

            // Emit incoming raw FIDO report so your Native C++ Addon can process it
            this.emit('fido-output', data);
        } else if (type === UHID_START) {
            console.log('[UHID] Kernel started virtual device driver hooks.');
        } else if (type === UHID_OPEN) {
            console.log('[UHID] WebAuthn browser stack or client application opened device handle.');
        }
    }

    /**
     * Sends a 64-byte raw FIDO response back to the browser via kernel
     * @param {Buffer} fidoReport - 64 byte buffer containing FIDO/U2F response
     */
    sendFidoReport(fidoReport) {
        // UHID_INPUT2 Struct layout: type(4B) + size(2B) + data(64B max)
        const header = Buffer.alloc(6);
        header.writeUInt32LE(UHID_INPUT2, 0);
        header.writeUInt16LE(fidoReport.length, 4);

        const payload = Buffer.concat([header, fidoReport]);
        fs.writeSync(this.fd, payload);
    }

    /**
     * Sends a standard 8-byte HID keyboard report
     */
    sendKeyboardReport(modifier, keycode) {
        const header = Buffer.alloc(6);
        header.writeUInt32LE(UHID_INPUT2, 0);
        header.writeUInt16LE(8, 4);

        const hidReport = Buffer.from([modifier, 0, keycode, 0, 0, 0, 0, 0]);
        const payload = Buffer.concat([header, hidReport]);
        fs.writeSync(this.fd, payload);
    }

    close() {
        if (this.fd !== null) {
            try { fs.closeSync(this.fd); } catch (e) { }
        }
    }
}

module.exports = UHIDDevice;

// Standalone execution test
if (require.main === module) {
    const device = new UHIDDevice();
    device.start();

    device.on('fido-output', (data) => {
        console.log('[UHID] Received raw FIDO packet from Browser:', data.toString('hex'));
    });

    process.on('SIGINT', () => {
        console.log('\nClosing virtual device...');
        device.close();
        process.exit(0);
    });
}