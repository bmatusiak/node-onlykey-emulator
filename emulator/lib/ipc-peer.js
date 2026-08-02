/*
 * ipc-peer.js - the CONNECTING side of the bridge. Used by the emulator daemon.
 *
 * Roles are inverted from the obvious arrangement on purpose: the GUI listens
 * and the emulator dials out. The emulator is the process that keeps
 * restarting (every CPU_RESTART() exits it and pm2 respawns it), and a
 * restarting process should not be the one holding the socket - see the
 * rationale in ipc-host.js.
 *
 * With no host listening this simply keeps retrying, so the emulator runs
 * headless without complaint. Nothing about the HID interfaces depends on this
 * channel.
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const { defaultSocketPath, createFramer, encode, b64 } = require('./protocol');

class IpcPeer extends EventEmitter {
  /**
   * @param {object} emu   the OnlyKeyEmulator instance to expose
   * @param {object} [opts]
   */
  constructor(emu, opts = {}) {
    super();
    this.emu = emu;
    this.socketPath = opts.socketPath || defaultSocketPath();
    this.retryMs = opts.retryMs || 500;
    this.maxRetryMs = opts.maxRetryMs || 5000;
    this.sock = null;
    this.connected = false;
    this._closed = false;
    this._delay = this.retryMs;
    this.uhid = false;
    this.plugged = false;
  }

  start() {
    this._wireEmulator();
    this._open();
    return this;
  }

  _open() {
    if (this._closed) return;

    const sock = net.connect(this.socketPath);
    this.sock = sock;
    sock.setNoDelay(true);

    const feed = createFramer(
      (msg) => this._onCommand(msg),
      (err) => this.emit('error', err)
    );

    sock.on('connect', () => {
      this.connected = true;
      this._delay = this.retryMs;
      this.emit('connect');
      /*
       * Include the current LED state in `ready`.
       *
       * The firmware only publishes the LED when it calls pixels.show(), so a
       * host that attaches to an idle device would otherwise sit on black
       * until the next colour change - which, once the device settles, may
       * never come. Sending the last known colour on connect means a GUI
       * started after the emulator shows the real state immediately, without
       * waiting for a getState() round trip.
       */
      this._send({
        t: 'ready',
        version: require('../package.json').version,
        storageDir: this.emu.storageDir,
        uhid: this.uhid,
        plugged: this.plugged,
        led: this.emu.led,
      });
    });

    sock.on('data', feed);

    /* No host yet is the normal state when the GUI is not running - retry
     * quietly rather than treating it as an error. */
    sock.on('error', () => {});
    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.sock = null;
      if (was) this.emit('disconnect');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._closed) return;
    const wait = this._delay;
    this._delay = Math.min(this._delay * 2, this.maxRetryMs);
    /*
     * Deliberately NOT unref()'d. This timer is the only thing keeping the
     * daemon's event loop ticking once the GUI goes away - the firmware runs
     * on its own native thread and does not hold a libuv handle. With it
     * unref'd the loop had nothing referenced to service, retries silently
     * stopped, and the emulator would never reattach to a GUI started later
     * even though the process was still alive and running the firmware.
     *
     * Keeping it referenced is correct anyway: this is a supervised daemon
     * that should stay up, not a script that should exit when idle.
     */
    setTimeout(() => this._open(), wait);
  }

  _onCommand(msg) {
    try {
      switch (msg.t) {
        case 'press':         this.emu.pressButton(msg.button, { long: !!msg.long }); break;
        case 'setButton':     this.emu.setButton(msg.button, !!msg.down); break;
        case 'writeHid':      this.emu.writeHid(b64.unpack(msg.data), msg.iface); break;
        case 'factoryReset':  this.emu.factoryReset(); break;
        case 'restartDevice': this.emu.restartDevice(); break;
        case 'rebuild':       this.emit('rebuild'); break;
        case 'setPlugged':    this.emit('set-plugged', !!msg.plugged); break;
        case 'getState':
          this._send({
            t: 'state',
            led: this.emu.led,
            uhid: this.uhid,
            plugged: this.plugged,
            started: this.emu.started,
            storageDir: this.emu.storageDir,
          });
          break;
        default:
          this._send({ t: 'error', message: `unknown command: ${msg.t}` });
      }
    } catch (err) {
      this._send({ t: 'error', message: err.message });
    }
  }

  _wireEmulator() {
    const emu = this.emu;
    emu.on('led', (pixels) => this._send({ t: 'led', pixels }));
    emu.on('keyboard', (data) => this._send({ t: 'keyboard', data: b64.pack(data) }));
    emu.on('log', (text) => this._send({ t: 'log', text }));
    emu.on('stream', ({ buffer, iface, name, dir }) => {
      /* SEREMU output already goes out as `log`; re-sending it as a hid frame
       * would double every line in the GUI's debug view. */
      if (name === 'seremu' && dir === 'out') return;
      this._send({ t: 'hid', iface, name, dir, data: b64.pack(buffer) });
    });
    emu.on('restart', () => this._send({ t: 'restart' }));
  }

  /** Tell the host about a plug/unplug that has just taken effect. */
  publishPlugged(plugged) {
    this.plugged = plugged;
    this._send({ t: 'plugged', plugged });
  }

  _send(msg) {
    if (this.sock && this.connected && this.sock.writable) {
      this.sock.write(encode(msg));
    }
  }

  close() {
    this._closed = true;
    if (this.sock) this.sock.destroy();
    this.sock = null;
    this.connected = false;
  }
}

module.exports = IpcPeer;
