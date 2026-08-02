/*
 * ipc-client.js - client side of the emulator IPC bridge.
 *
 * Used by the NW.js GUI and by test harnesses. The important behaviour is
 * reconnection: the emulator process exits and is respawned by pm2 every time
 * the firmware reboots, so a dropped socket is routine, not an error. The
 * client retries with backoff and re-emits `ready` on each successful attach,
 * which is the GUI's cue to re-request state.
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const { defaultSocketPath, createFramer, encode, b64 } = require('./protocol');

class IpcClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.socketPath = opts.socketPath || defaultSocketPath();
    this.retryMs = opts.retryMs || 250;
    this.maxRetryMs = opts.maxRetryMs || 3000;
    this.sock = null;
    this.connected = false;
    this._closed = false;
    this._delay = this.retryMs;
  }

  connect() {
    this._closed = false;
    this._open();
    return this;
  }

  _open() {
    if (this._closed) return;

    const sock = net.connect(this.socketPath);
    this.sock = sock;
    sock.setNoDelay(true);

    const feed = createFramer(
      (msg) => this._onFrame(msg),
      (err) => this.emit('error', err)
    );

    sock.on('connect', () => {
      this.connected = true;
      this._delay = this.retryMs;   // reset backoff on a good connection
      this.emit('connect');
    });

    sock.on('data', feed);

    /* Both paths just mean "the emulator went away" - most often a restart. */
    sock.on('error', (err) => {
      if (!this.connected) this.emit('reconnecting', err.code || err.message);
    });
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
    setTimeout(() => this._open(), wait).unref?.();
  }

  _onFrame(msg) {
    this.emit('message', msg);
    this.emit(msg.t, msg);
  }

  _send(msg) {
    if (this.sock && this.connected) this.sock.write(encode(msg));
  }

  /* ---- commands ---- */
  press(button, opts = {}) { this._send({ t: 'press', button, long: !!opts.long }); }
  setButton(button, down)  { this._send({ t: 'setButton', button, down: !!down }); }
  writeHid(iface, data)    { this._send({ t: 'writeHid', iface, data: b64.pack(data) }); }
  factoryReset()           { this._send({ t: 'factoryReset' }); }
  restartDevice()          { this._send({ t: 'restartDevice' }); }
  rebuild()                { this._send({ t: 'rebuild' }); }
  getState()               { this._send({ t: 'getState' }); }

  close() {
    this._closed = true;
    if (this.sock) this.sock.destroy();
    this.sock = null;
    this.connected = false;
  }
}

module.exports = IpcClient;
