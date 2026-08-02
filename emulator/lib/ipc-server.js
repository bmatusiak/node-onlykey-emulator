/*
 * ipc-server.js - Unix domain socket bridge between the emulator and the GUI.
 *
 * The GUI and the emulator are separate processes on purpose: the emulator is
 * restarted (by pm2) whenever the firmware calls CPU_RESTART(), and the GUI
 * has to survive that and reconnect. So this server is deliberately dumb -
 * it holds no state the client cannot re-request with `getState`.
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { defaultSocketPath, createFramer, encode, b64 } = require('./protocol');

class IpcServer extends EventEmitter {
  /**
   * @param {object} emu   the OnlyKeyEmulator instance to expose
   * @param {object} [opts]
   * @param {string} [opts.socketPath]
   */
  constructor(emu, opts = {}) {
    super();
    this.emu = emu;
    this.socketPath = opts.socketPath || defaultSocketPath();
    this.clients = new Set();
    this.server = null;
    this.uhid = false;
  }

  /*
   * Async because the staleness probe is: we must know whether the leftover
   * socket answers *before* binding. An earlier version probed with callbacks
   * and bound immediately, so the probe's error handler would fire after
   * listen() had already created a new socket file - and unlink it. The result
   * was a live daemon with no reachable socket, every time pm2 restarted it.
   */
  async listen() {
    await this._clearStaleSocket();
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    this.server = net.createServer((sock) => this._onConnection(sock));
    this.server.on('error', (err) => this.emit('error', err));

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        /* Owner-only: with no root in the picture, file permissions are the
         * access control for the emulated device. */
        try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
        this.emit('listening', this.socketPath);
        resolve();
      });
    });

    this._wireEmulator();
    return this;
  }

  /*
   * A socket file left behind by a killed process makes listen() fail with
   * EADDRINUSE forever, and pm2 restarts us often enough that this is the
   * normal case rather than an edge one. Probe it: if nothing answers it is
   * stale and safe to remove; if something does answer, another emulator owns
   * it and we must not steal it.
   */
  _clearStaleSocket() {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.socketPath)) return resolve();

      const probe = net.connect(this.socketPath);
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        probe.destroy();
        fn(arg);
      };

      probe.on('connect', () => done(reject, new Error(
        `another emulator is already listening on ${this.socketPath}`)));

      /* ECONNREFUSED on a socket file means nobody is bound to it. */
      probe.on('error', () => {
        try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
        done(resolve);
      });

      probe.setTimeout(250, () => {
        /* Bound but not accepting - treat as owned, do not remove it. */
        done(reject, new Error(
          `socket ${this.socketPath} exists but did not respond`));
      });
    });
  }

  _onConnection(sock) {
    this.clients.add(sock);
    sock.setNoDelay(true);

    const feed = createFramer(
      (msg) => this._onCommand(msg, sock),
      (err) => this.emit('error', err)
    );
    sock.on('data', feed);

    const drop = () => this.clients.delete(sock);
    sock.on('close', drop);
    /* A GUI that goes away mid-write must not take the emulator down. */
    sock.on('error', drop);

    this._send(sock, {
      t: 'ready',
      version: require('../package.json').version,
      storageDir: this.emu.storageDir,
      uhid: this.uhid,
    });
    this.emit('client', this.clients.size);
  }

  _onCommand(msg, sock) {
    try {
      switch (msg.t) {
        case 'press':
          this.emu.pressButton(msg.button, { long: !!msg.long });
          break;
        case 'setButton':
          this.emu.setButton(msg.button, !!msg.down);
          break;
        case 'writeHid':
          this.emu.writeHid(b64.unpack(msg.data), msg.iface);
          break;
        case 'factoryReset':
          this.emu.factoryReset();
          break;
        case 'restartDevice':
          this.emu.restartDevice();
          break;
        case 'rebuild':
          this.emit('rebuild');
          break;
        case 'getState':
          this._send(sock, {
            t: 'state',
            led: this.emu.led,
            uhid: this.uhid,
            started: this.emu.started,
            storageDir: this.emu.storageDir,
          });
          break;
        default:
          this._send(sock, { t: 'error', message: `unknown command: ${msg.t}` });
      }
    } catch (err) {
      /* A bad command from the GUI is reported back, never fatal here. */
      this._send(sock, { t: 'error', message: err.message });
    }
  }

  _wireEmulator() {
    const emu = this.emu;
    emu.on('led', (pixels) => this.broadcast({ t: 'led', pixels }));
    emu.on('keyboard', (data) =>
      this.broadcast({ t: 'keyboard', data: b64.pack(data) }));
    emu.on('log', (text) => this.broadcast({ t: 'log', text }));
    emu.on('stream', ({ buffer, iface, name, dir }) => {
      /* SEREMU output is already delivered as `log`; re-sending it as a hid
       * frame would double every line in the GUI's debug view. */
      if (name === 'seremu' && dir === 'out') return;
      this.broadcast({ t: 'hid', iface, name, dir, data: b64.pack(buffer) });
    });
    emu.on('restart', () => this.broadcast({ t: 'restart' }));
  }

  broadcast(msg) {
    const frame = encode(msg);
    for (const sock of this.clients) {
      if (sock.writable) sock.write(frame);
    }
  }

  _send(sock, msg) {
    if (sock.writable) sock.write(encode(msg));
  }

  close() {
    for (const sock of this.clients) sock.destroy();
    this.clients.clear();
    if (this.server) this.server.close();
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }
}

module.exports = IpcServer;
