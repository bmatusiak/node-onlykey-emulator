/*
 * power.js - unplug / plug in, modelled as what it physically is.
 *
 * An OnlyKey is bus-powered. There is no scenario in which it is unplugged and
 * still running, so "unplug" here means both halves:
 *
 *   1. unbind the gadget from the UDC, so Linux stops seeing the device at all
 *      (hidraw nodes disappear, and are renumbered on re-plug exactly as they
 *      are on real re-enumeration), and
 *   2. stop the emulator process, so the firmware loses power and its RAM.
 *
 * The earlier behaviour - tear down the interfaces but leave the firmware
 * running with RAM intact - made the firmware's own recovery instruction a
 * lie. exceeded_login_attempts() is `while (1==1) { hidprint("...remove
 * OnlyKey and reinsert..."); }`, an infinite loop with no exit: on hardware
 * removing the key cuts power and the MCU resets, which is precisely how you
 * escape it. Against an emulator that kept running, "remove and reinsert" did
 * nothing and the device stayed wedged until pm2 was restarted by hand.
 *
 * Stopping has to go through pm2, not process.exit(): pm2's whole job here is
 * to respawn the daemon after CPU_RESTART(), so a plain exit would come
 * straight back up. `pm2 stop` marks it stopped and it stays down.
 */
'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

const GADGET_DIR = process.env.OKEMU_GADGET_DIR
  || '/sys/kernel/config/usb_gadget/onlykey';
const UDC_FILE = `${GADGET_DIR}/UDC`;
const PM2_APP = process.env.OKEMU_PM2_APP || 'onlykey-emulator';
const PM2_BIN = process.env.OKEMU_PM2_BIN || 'pm2';

/** Name of the controller to bind to, e.g. "dummy_udc.0". */
function udcName() {
  try {
    const bound = fs.readFileSync(UDC_FILE, 'utf8').trim();
    if (bound) return bound;
  } catch { /* fall through */ }
  try {
    return fs.readdirSync('/sys/class/udc')[0] || null;
  } catch { return null; }
}

function isBound() {
  try { return fs.readFileSync(UDC_FILE, 'utf8').trim().length > 0; }
  catch { return false; }
}

function pm2(action) {
  return new Promise((resolve, reject) => {
    execFile(PM2_BIN, [action, PM2_APP], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`pm2 ${action} ${PM2_APP}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cut power: detach from the bus, then stop the firmware process. */
async function powerOff() {
  const name = udcName();          /* remember it before unbinding */
  if (isBound()) fs.writeFileSync(UDC_FILE, '\n');
  await pm2('stop');
  return name;
}

/**
 * Restore power: start the firmware first so it has /dev/hidgN open, then
 * attach to the bus. Binding before the daemon is up would enumerate a device
 * that answers nothing.
 */
async function powerOn() {
  await pm2('start');
  await sleep(1500);
  const name = udcName();
  if (!name) throw new Error('no UDC available - run scripts/gadget-setup.sh');
  if (!isBound()) fs.writeFileSync(UDC_FILE, `${name}\n`);
  return name;
}

module.exports = { powerOff, powerOn, isBound, udcName, UDC_FILE, GADGET_DIR };
