#!/usr/bin/env node
/*
 * press.js - send button presses to the running emulator, without the GUI.
 *
 *   ./emulator/bin/press.js 1              tap button 1
 *   ./emulator/bin/press.js 1 2 3 4        a four-digit PIN
 *   ./emulator/bin/press.js 3:long         hold tiers: tap|hold|long|longest
 *   ./emulator/bin/press.js 6#120          an exact firmware tick count
 *   ./emulator/bin/press.js --watch        no presses, just stream LED + debug
 *
 * Why this listens rather than connects
 * -------------------------------------
 * The socket topology is inverted from the obvious one: the emulator is the
 * side that DIALS OUT, because it is the process that keeps dying (every
 * CPU_RESTART() exits it and pm2 respawns it) - see ipc-host.js. So a tool that
 * wants to talk to it has to be the listener, exactly as the GUI is.
 *
 * That also means only one of these may run at a time, and not alongside the
 * GUI: whoever holds the socket owns the device. The emulator redials with a
 * 500ms backoff that caps at 5s, so expect up to ~5s before it appears.
 */
'use strict';

const IpcHost = require('../lib/ipc-host');

const HOLD_TIERS = ['tap', 'hold', 'long', 'longest'];

function usage(msg) {
  if (msg) console.error(`press: ${msg}\n`);
  console.error(`usage: press.js [options] [button ...]

  button      1..6, optionally  N:tier  or  N#ticks
              tier is one of: ${HOLD_TIERS.join(', ')}  (default tap)

  --hold=T    default tier for bare button numbers
  --watch     keep running and stream LED and debug output
  --socket=P  socket path (default: $XDG_RUNTIME_DIR/onlykey-emulator.sock)
  --wait=MS   how long to wait for the emulator to dial in (default 8000)
  --quiet     suppress LED and debug output
`);
  process.exit(msg ? 2 : 0);
}

/* ------------------------------------------------------------------ args */
const opts = { watch: false, quiet: false, wait: 8000, socketPath: undefined, hold: 'tap' };
const presses = [];

for (const arg of process.argv.slice(2)) {
  if (arg === '-h' || arg === '--help') usage();
  else if (arg === '--watch') opts.watch = true;
  else if (arg === '--quiet') opts.quiet = true;
  else if (arg.startsWith('--socket=')) opts.socketPath = arg.slice(9);
  else if (arg.startsWith('--wait=')) opts.wait = Number(arg.slice(7));
  else if (arg.startsWith('--hold=')) opts.hold = arg.slice(7);
  else if (arg.startsWith('-')) usage(`unknown option ${arg}`);
  else {
    /* N, N:tier or N#ticks - the ':' and '#' forms mirror the firmware's own. */
    const m = /^([1-6])(?::([a-z]+)|#(\d+))?$/.exec(arg);
    if (!m) usage(`bad button "${arg}" - want 1..6, N:tier or N#ticks`);
    const p = { button: Number(m[1]) };
    if (m[3]) p.ticks = Number(m[3]);
    else p.hold = m[2] || opts.hold;
    presses.push(p);
  }
}

if (!HOLD_TIERS.includes(opts.hold)) usage(`--hold must be one of ${HOLD_TIERS.join(', ')}`);
for (const p of presses) {
  if (p.hold && !HOLD_TIERS.includes(p.hold)) usage(`bad tier "${p.hold}"`);
}
/* 16 is the firmware's queue depth (DBG_QUEUE_MAX); past that it drops the
 * tail rather than pressing something the caller did not ask for. */
if (presses.length > 16) usage(`at most 16 presses per run, got ${presses.length}`);
if (!presses.length && !opts.watch) usage('nothing to do - give a button, or --watch');

/* ------------------------------------------------------------------ run */
const host = new IpcHost({ socketPath: opts.socketPath });

try {
  host.listen();
} catch (err) {
  console.error(`press: ${err.message}`);
  console.error('       Stop the GUI (or another press.js) and try again.');
  process.exit(1);
}

const timer = setTimeout(() => {
  console.error(`press: no emulator connected within ${opts.wait}ms.`);
  console.error('       Is it running?  pm2 status onlykey-emulator');
  host.close();
  process.exit(1);
}, opts.wait);

if (!opts.quiet) {
  host.on('log', (m) => process.stdout.write(m.text));
  host.on('led', (m) => {
    const hex = (m.pixels || [])
      .map((p) => `#${[p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
      .join(' ');
    console.log(`[LED] ${hex}`);
  });
}

/*
 * `ready` rather than `device-connect`: the socket being up says nothing about
 * the firmware thread having started, and a press sent before it has is simply
 * dropped.
 */
host.once('ready', () => {
  clearTimeout(timer);

  /*
   * Every press goes out in a single write, so the frames arrive in one chunk
   * and are handled in one tick. The IPC has no batch command, and a PIN
   * entered with host-side delay between digits is the documented way to get
   * this wrong - this is what keeps that delay at zero.
   */
  for (const p of presses) host.press(p.button, p);

  if (presses.length) {
    const shown = presses
      .map((p) => (p.ticks ? `${p.button}#${p.ticks}` : `${p.button}:${p.hold}`))
      .join(' ');
    console.error(`press: sent ${shown}`);
  }

  if (opts.watch) return;              /* stay up and keep streaming */

  /*
   * The firmware paces the replay itself, so the presses are queued rather than
   * done when the write returns. Linger briefly to let the device act on them
   * and to catch the LED/debug output they produce; closing immediately would
   * cut off the very feedback that tells you the press landed.
   */
  setTimeout(() => { host.close(); process.exit(0); }, 400 + 250 * presses.length);
});

process.on('SIGINT', () => { host.close(); process.exit(0); });
