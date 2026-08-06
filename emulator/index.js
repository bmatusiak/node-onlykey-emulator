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
 * a line of ASCII digits selects the buttons, '!' per hold tier modifies the
 * digit before it, and newline commits the line. The firmware replays the
 * presses one per loop() iteration, so a whole sequence goes in one write.
 *
 * This - not the analog touch pads - is the supported way to drive buttons,
 * per EXPLAINER.md line 15. It only exists in DEBUG firmware builds.
 */
const PRESS_TERMINATOR = '\n';

/*
 * Hold tiers, and the firmware duration each maps to. The bands that matter in
 * payload() (OnlyKey.ino): <=20 tap, >=72 hold actions, >=140 key labels,
 * >=180 DUO config mode, >=360 DUO factory default - so 'hold' alone cannot
 * reach everything a physical hold can.
 */
const HOLD_MODIFIER = {
  tap: '',        // duration 1
  hold: '!',      // 128 - what the legacy space terminator produced
  long: '!!',     // 200
  longest: '!!!', // 400
};

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
   * @param {string}  [opts.hold]  'tap' (default), 'hold', 'long' or 'longest'
   * @param {number}  [opts.ticks] exact firmware duration, overrides opts.hold
   */
  pressButton(n, opts = {}) {
    if (!Number.isInteger(n) || n < 1 || n > 6) {
      throw new RangeError(`button must be 1..6, got ${n}`);
    }
    this.pressButtons([{ button: n, ...opts }]);
  }

  /**
   * Simulate a sequence of presses in one write. The firmware paces the replay
   * itself, so this is the reliable way to enter a PIN - no host-side delay
   * between digits to get wrong.
   * @param {Array<number|object>} presses button numbers, or pressButton() opts
   *                                       objects carrying a `button` field
   */
  pressButtons(presses) {
    // 16 is the firmware's queue depth (DBG_QUEUE_MAX); past that it drops the
    // tail with a warning on the debug channel rather than pressing something
    // the caller did not ask for.
    if (presses.length > 16) {
      throw new RangeError(`at most 16 presses per line, got ${presses.length}`);
    }

    const line = presses.map((p) => {
      const { button, hold, ticks } = typeof p === 'object' ? p : { button: p };
      if (!Number.isInteger(button) || button < 1 || button > 6) {
        throw new RangeError(`button must be 1..6, got ${button}`);
      }
      if (ticks !== undefined) {
        if (!Number.isInteger(ticks) || ticks < 1) {
          throw new RangeError(`ticks must be a positive integer, got ${ticks}`);
        }
        return `${button}#${ticks}`;
      }
      const tier = hold || 'tap';
      if (!(tier in HOLD_MODIFIER)) {
        throw new RangeError(`hold must be one of ${Object.keys(HOLD_MODIFIER).join(', ')}, got ${tier}`);
      }
      return `${button}${HOLD_MODIFIER[tier]}`;
    }).join('');

    // And 32 is its raw line buffer (DBG_LINE_MAX, one SEREMU OUT report),
    // which the modifiers can exhaust before the queue does - sixteen 'longest'
    // holds is 64 bytes.
    if (line.length > 32) {
      throw new RangeError(`press line is ${line.length} bytes, firmware accepts 32: ${line}`);
    }

    this.writeHid(Buffer.from(`${line}${PRESS_TERMINATOR}`, 'latin1'), IFACE.SEREMU);
  }

  /*
   * Debug-only firmware command paths on the same channel. The wipes spell out
   * their own confirmation ('0C'/'9C') so that no single stray byte can erase
   * the device; there is no separate confirm step to follow them with.
   */
  restartDevice()  { this.writeHid(Buffer.from('8\n', 'latin1'), IFACE.SEREMU); }
  wipeUserspace()  { this.writeHid(Buffer.from('0C\n', 'latin1'), IFACE.SEREMU); }
  wipeAll()        { this.writeHid(Buffer.from('9C\n', 'latin1'), IFACE.SEREMU); }

  /*
   * HID CONTROL TRANSFERS ON THE KEYBOARD INTERFACE, WHICH ARE NOT writeHid().
   *
   * SET_REPORT (0x0921) and GET_REPORT (0x01a1) are a different transfer type
   * from the interrupt OUT reports writeHid() sends, and they reach a different
   * handler: process_setreport() in okcore.cpp, which is the Yubikey-style
   * HMAC-SHA1 challenge-response channel. Nothing else in this API can reach it
   * - an interrupt OUT report on IFACE.KEYBOARD is simply not a control
   * transfer, so device.send(KEYBOARD, ...) goes somewhere else entirely.
   *
   * The firmware side has been ported all along (core-override/okemu_usb.cpp
   * carries the whole state machine, including the multi-report 0xC0..0xC3 read
   * and the waiting-for-a-press path) and uhid-bridge.js already drives it for
   * the gadget. These two methods are what let an IPC client reach the same
   * place without a kernel device node.
   */
  kbdSetReport(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    return native.kbdSetReport(buffer);
  }

  /** Device -> host, the answer side of the same channel. Returns a Buffer. */
  kbdGetReport() {
    return native.kbdGetReport();
  }

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
