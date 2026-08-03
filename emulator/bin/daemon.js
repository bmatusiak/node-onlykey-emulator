#!/usr/bin/env node
/*
 * daemon.js - the emulator process. This is what pm2 supervises.
 *
 * Restart model (EXPLAINER.md line 25): the firmware's CPU_RESTART() surfaces
 * as a JS event; we exit, and pm2 brings the process back. A reboot is not a
 * wipe - flash.bin and eeprom.bin are file-backed, so the emulated device
 * keeps its keys, PINs and slots across the respawn, exactly as real hardware
 * keeps its flash across a reset.
 *
 * The GUI's "recompile and restart" is the same path with `npm run build`
 * first, so a firmware source change is picked up by the new process.
 *
 * Nothing here needs root. /dev/uhid access is granted once by
 * scripts/setup-permissions.sh; if it is missing we run without a real HID
 * device and say so, rather than failing to start.
 *
 * Usage:
 *   node bin/daemon.js [--socket PATH] [--storage DIR] [--no-uhid]
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const emu = require('../index');
const IpcPeer = require('../lib/ipc-peer');
const { defaultSocketPath } = require('../lib/protocol');

/* Exit codes are how pm2 tells a reboot from a real failure. */
const EXIT_RESTART = 0;   // expected: firmware reboot, pm2 should respawn
const EXIT_FATAL = 1;

function parseArgs(argv) {
  const out = { uhid: true, socket: defaultSocketPath(), storage: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-uhid') out.uhid = false;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--socket') out.socket = argv[++i];
    else if (a === '--storage') out.storage = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('usage: daemon.js [--socket PATH] [--storage DIR] [--no-uhid] [--quiet]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const log = (...m) => console.log('[okemu]', ...m);

async function main() {
  emu.start({ storageDir: args.storage });
  log(`firmware running, storage: ${emu.storageDir}`);

  /*
   * Tee the firmware's SEREMU output to stdout as well as to IPC clients.
   * Without this it is only visible to something attached to the socket, so
   * `pm2 logs` shows the daemon's own lines but none of the device's - which
   * makes anything that goes wrong before a client attaches invisible.
   * Written raw, with no prefix, so it reads as the device's own console.
   * --quiet suppresses it; the firmware is chatty in DEBUG builds.
   */
  if (!args.quiet) emu.on('log', (text) => process.stdout.write(text));

  /*
   * The GUI listens; we dial out. This process restarts on every
   * CPU_RESTART(), so it must not be the one owning the socket - see
   * lib/ipc-host.js. With no GUI running this retries quietly and the
   * emulator runs headless.
   */
  const ipc = new IpcPeer(emu, { socketPath: args.socket });
  ipc.on('connect', () => log(`attached to GUI at ${ipc.socketPath}`));
  ipc.on('disconnect', () => log('GUI detached - retrying'));
  ipc.on('error', (err) => log('IPC error:', err.message));

  /*
   * Optional HID bridge - presents the emulated device to the real OS.
   *
   * Default is the USB-gadget bridge (dummy_hcd + f_hid), because only a real
   * USB device carries the descriptor fields software identifies an OnlyKey
   * by: hidapi reports manufacturer '' and interface -1 for a UHID device,
   * which no unmodified client can match. OKEMU_BRIDGE=uhid selects the old
   * transport, which needs no kernel module and is still useful for
   * HID-plumbing work where those fields do not matter.
   */
  let bridge = null;
  if (args.uhid) {
    const kind = process.env.OKEMU_BRIDGE === 'uhid' ? 'uhid' : 'gadget';
    const mod = kind === 'uhid' ? '../lib/uhid-bridge' : '../lib/gadget-bridge';
    try {
      const Bridge = require(mod);
      bridge = new Bridge(emu);
      bridge.start();
      ipc.uhid = true;
      ipc.plugged = true;
      log(`${kind} bridge active - device visible to the OS`);
    } catch (err) {
      bridge = null;
      ipc.uhid = false;
      log(`${kind} bridge unavailable (${err.message})`);
      log(kind === 'gadget'
        ? '  run  sudo ./scripts/gadget-setup.sh  once to enable it'
        : '  run  sudo ./scripts/setup-permissions.sh  once to enable it');
      log('  the emulator still works over IPC either way');
    }
  }

  /*
   * Plug / unplug from the GUI. This tears the HID interfaces down and back
   * up, so the OS and every client see the key removed and reinserted, while
   * the firmware keeps running - the USB cable, not the power.
   */
  ipc.on('set-plugged', (want) => {
    if (!bridge) return;
    const changed = want ? bridge.plug() : bridge.unplug();
    if (changed) log(want ? 'plugged in - HID interfaces created'
                          : 'unplugged - HID interfaces removed');
    ipc.publishPlugged(bridge.plugged);
  });

  ipc.start();

  /*
   * Shutting down has to thread a needle between two deadlocks, both of which
   * leave a wedged daemon that pm2 never respawns:
   *
   *   - The restart path arrives here from inside the native restart callback,
   *     which runs as a ThreadSafeFunction call. Calling emu.stop() (which
   *     releases that TSFN) from within its own callback waits for the
   *     callback to return: deadlock.
   *   - But skipping the release is not an option either. An unreleased TSFN
   *     keeps the environment referenced, and process.exit() then blocks in
   *     teardown - the process logs "exiting" and lives on forever.
   *
   * So: defer to setImmediate, by which point the callback has unwound, then
   * release and exit. The SIGKILL backstop covers anything still holding on;
   * a reboot must always actually reboot, and the emulated flash and EEPROM
   * are MAP_SHARED file-backed, so the kernel persists them either way.
   */
  let exiting = false;
  const shutdown = (code, why) => {
    if (exiting) return;
    exiting = true;
    log(`${why} - exiting (${code})`);
    try { ipc.close(); } catch (e) { log('ipc.close threw:', e.message); }

    /*
     * SIGKILL rather than process.exit(): Node's graceful teardown reliably
     * wedges here. The addon holds ThreadSafeFunctions and a detached firmware
     * thread, and exiting through V8 disposal blocks on them - measured as a
     * process that logs "exiting" and then lives forever with its socket
     * already unlinked, so pm2 never respawns and the GUI never reconnects.
     * A JS timer cannot back that out either, since the event loop is gone by
     * the time it would fire.
     *
     * This is a device reboot, so an abrupt exit is the honest model anyway,
     * and it loses nothing: eeprom writes are pwrite()n as they happen, and
     * the flash mapping is MAP_SHARED file-backed, so the kernel flushes it
     * from the page cache regardless of how the process dies.
     */
    setImmediate(() => process.kill(process.pid, 'SIGKILL'));
  };

  /*
   * CPU_RESTART(): the firmware thread has already parked, so the device is
   * doing nothing until we come back. Exit and let pm2 respawn.
   */
  emu.on('restart', () => shutdown(EXIT_RESTART, 'firmware requested restart'));

  ipc.on('rebuild', () => {
    log('rebuild requested - running npm run build');
    const r = spawnSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      /* Don't exit on a failed build: that would have pm2 respawn us onto the
       * old binary in a loop while the developer is still fixing the error. */
      log('build FAILED - staying up on the previously built module');
      ipc.broadcast({ t: 'error', message: 'rebuild failed, see daemon output' });
      return;
    }
    shutdown(EXIT_RESTART, 'rebuild succeeded');
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => shutdown(EXIT_RESTART, sig));
  }
}

main().catch((err) => {
  console.error('[okemu] fatal:', err.message);
  process.exit(EXIT_FATAL);
});
