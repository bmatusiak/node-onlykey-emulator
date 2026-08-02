/*
 * smoke.js - does the firmware actually boot inside Node?
 *
 * Starts the emulator against a scratch storage dir and reports what the
 * device does in its first couple of seconds: debug output from SEREMU, LED
 * colour changes, keystrokes, HID traffic, and any reboot request.
 *
 * Usage: node test/smoke.js [storageDir]
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const native = require('../build/Release/onlykey_emulator.node');

const storageDir = process.argv[2] ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'okemu-smoke-'));

console.log(`storage: ${storageDir}\n`);

let logBytes = 0;
let lastLed = null;
const counts = { led: 0, kbd: 0, hid: 0, restart: 0 };

native.start({
  storageDir,

  onLog(buf) {
    logBytes += buf.length;
    process.stdout.write(buf.toString('latin1'));
  },

  onLed(px) {
    counts.led++;
    const s = px.map((p) => `#${[p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`).join(' ');
    if (s !== lastLed) {
      lastLed = s;
      console.log(`\n[LED] ${s}`);
    }
  },

  onKeyboard(buf) {
    counts.kbd++;
    console.log(`\n[KBD] ${buf.toString('hex')}`);
  },

  onHid(buf, iface) {
    counts.hid++;
    console.log(`\n[HID iface=${iface}] ${buf.subarray(0, 16).toString('hex')}...`);
  },

  onRestart() {
    counts.restart++;
    console.log('\n[RESTART] firmware requested a reboot');
  },
});

console.log('firmware thread started; observing for 2s...\n');

setTimeout(() => {
  console.log('\n\n--- summary ---');
  console.log(`serial/debug bytes : ${logBytes}`);
  console.log(`LED updates        : ${counts.led}`);
  console.log(`keyboard reports   : ${counts.kbd}`);
  console.log(`HID packets out    : ${counts.hid}`);
  console.log(`restart requests   : ${counts.restart}`);
  for (const f of ['flash.bin', 'eeprom.bin']) {
    const p = path.join(storageDir, f);
    console.log(`${f.padEnd(19)}: ${fs.existsSync(p) ? fs.statSync(p).size + ' bytes' : 'MISSING'}`);
  }
  native.stop();
  process.exit(0);
}, 2000);
