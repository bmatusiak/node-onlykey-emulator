/*
 * index.js - the JavaScript face of the OnlyKey emulator.
 *
 * Wraps the native addon in an EventEmitter and demuxes the single native
 * bus stream into named events. Interface numbers are usb_desc.h's, which is
 * what the firmware and the HID descriptors use:
 *
 *   0  Keyboard      device -> host      (HID1 in the UI)
 *   1  RawHID  FIDO  bidirectional       (HID2, usage page 0xF1D0)
 *   2  RawHID2 vendor bidirectional      (HID3, usage page 0xFFAB)
 *   3  SEREMU  debug bidirectional       (HID4, DEBUG builds only)
 */
'use strict';

const EventEmitter = require('events');
const path = require('path');

const native = require('./build/Release/onlykey_emulator.node');

const IFACE = {
  KEYBOARD: native.IFACE_KEYBOARD,
  FIDO: native.IFACE_FIDO,
  VENDOR: native.IFACE_VENDOR,
  SEREMU: native.IFACE_SEREMU,
};

const IFACE_NAME = {
  [IFACE.KEYBOARD]: 'keyboard',
  [IFACE.FIDO]: 'fido',
  [IFACE.VENDOR]: 'vendor',
  [IFACE.SEREMU]: 'seremu',
};

/*
 * The firmware's own debug button harness (okcore.cpp, touch_sense_loop):
 * an ASCII digit selects the button, then a terminator commits the press -
 * newline for a short press, space for a long one (key_press = 128).
 *
 * This - not the analog touch pads - is the supported way to drive buttons,
 * per EXPLAINER.md line 15. It only exists in DEBUG firmware builds.
 */
const PRESS_SHORT = '\n';
const PRESS_LONG = ' ';

class OnlyKeyEmulator extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.led = [];
  }

  /**
   * @param {object}  [opts]
   * @param {string}  [opts.storageDir] where flash.bin / eeprom.bin live
   */
  start(opts = {}) {
    if (this.started) throw new Error('emulator already started');

    const storageDir = path.resolve(
      opts.storageDir || path.join(__dirname, '.onlykey-storage')
    );

    native.start({
      storageDir,

      onLed: (pixels) => {
        this.led = pixels;
        this.emit('led', pixels);
      },

      onStream: (buffer, iface, dir) => {
        // Raw bus trace first - this is what the UI debug log renders.
        this.emit('stream', { buffer, iface, name: IFACE_NAME[iface], dir });

        if (dir === 'out') {
          switch (iface) {
            case IFACE.KEYBOARD: this.emit('keyboard', buffer); break;
            case IFACE.SEREMU:   this.emit('log', buffer.toString('latin1')); break;
            default:             this.emit('hid', buffer, iface); break;
          }
        }
      },

      onRestart: () => this.emit('restart'),
    });

    this.started = true;
    this.storageDir = storageDir;
    return this;
  }

  /**
   * Simulate a button press. n is 1..6.
   * @param {number}  n
   * @param {object}  [opts]
   * @param {boolean} [opts.long] hold long enough to trigger the long-press action
   */
  pressButton(n, opts = {}) {
    if (!Number.isInteger(n) || n < 1 || n > 6) {
      throw new RangeError(`button must be 1..6, got ${n}`);
    }
    const terminator = opts.long ? PRESS_LONG : PRESS_SHORT;
    this.writeHid(Buffer.from(`${n}${terminator}`, 'latin1'), IFACE.SEREMU);
  }

  /*
   * Debug-only firmware commands on the same channel. '0' and '9' each need a
   * follow-up confirm() before anything is wiped - the firmware requires it so
   * a stray keystroke cannot erase the device.
   */
  restartDevice()  { this.writeHid(Buffer.from('8\n', 'latin1'), IFACE.SEREMU); }
  wipeUserspace()  { this.writeHid(Buffer.from('0 ', 'latin1'), IFACE.SEREMU); }
  wipeAll()        { this.writeHid(Buffer.from('9 ', 'latin1'), IFACE.SEREMU); }
  confirmWipe()    { this.writeHid(Buffer.from('C ', 'latin1'), IFACE.SEREMU); }

  /** Host -> device on a writable interface (FIDO, vendor or SEREMU). */
  writeHid(buffer, iface = IFACE.FIDO) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    native.sendHid(buffer, iface);
  }

  /** Raw analog touch pad state. The HID4 path above is the supported route. */
  setButton(n, down) { native.setButton(n, !!down); }

  /** Wipe flash + EEPROM back to erased (0xFF). */
  factoryReset() { native.factoryReset(); }

  stop() {
    if (!this.started) return;
    native.stop();
    this.started = false;
  }
}

module.exports = new OnlyKeyEmulator();
module.exports.OnlyKeyEmulator = OnlyKeyEmulator;
module.exports.IFACE = IFACE;
module.exports.IFACE_NAME = IFACE_NAME;
