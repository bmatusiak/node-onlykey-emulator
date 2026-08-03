/*
 * ipc-host.js - the LISTENING side of the bridge. Used by the GUI.
 *
 * The socket is owned by the GUI rather than the emulator, because the
 * emulator is the process that keeps dying: every CPU_RESTART() exits it and
 * pm2 respawns it. When the emulator owned the socket, each reboot destroyed
 * it and left the GUI reconnecting into a race - and a socket file left behind
 * by a killed process made the next bind fail with EADDRINUSE, which needed a
 * liveness probe to clear safely.
 *
 * With the long-lived process listening, a device reboot is just a client
 * disconnect and reconnect. The GUI keeps its window, its log and its state
 * across reboots, and none of the stale-socket handling is needed.
 *
 * Headless is still fine: with no host listening the emulator simply retries
 * forever and runs unattended. The HID interfaces (and therefore the test
 * harness) do not depend on this channel at all.
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { execFileSync } = require('child_process');

const { defaultSocketPath, createFramer, encode, b64 } = require('./protocol');

/*
 * Is anything actually accepting connections on this path?
 *
 * Done in a short-lived child rather than asynchronously, because listen() is
 * synchronous and callers rely on it either working or throwing. A refused
 * connection (ECONNREFUSED) means the file is stale and safe to remove;
 * anything else means someone is there.
 */
function probeLiveSocket(socketPath) {
  const script =
    'const net=require("net");' +
    'const s=net.connect(process.argv[1]);' +
    's.on("connect",()=>{s.destroy();process.exit(0);});' +
    's.on("error",()=>process.exit(3));' +
    'setTimeout(()=>process.exit(3),500);';
  try {
    execFileSync(process.execPath, ['-e', script, socketPath], {
      stdio: 'ignore', timeout: 2000,
    });
    return true;                 /* connected - a host is live */
  } catch {
    return false;                /* refused, or unreachable - stale */
  }
}

class IpcHost extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.socketPath = opts.socketPath || defaultSocketPath();
    this.server = null;
    this.device = null;      // the connected emulator, if any
    this.info = null;        // its last `ready` payload
  }

  listen() {
    /*
     * We own the socket now, so a leftover file is ours to remove: if another
     * host were already listening we would fail to bind and say so, rather
     * than silently taking over.
     */
    if (fs.existsSync(this.socketPath)) {
      /*
       * A socket file can mean two very different things: a live host, or a
       * leftover from one that was killed. Unlinking unconditionally - as this
       * did - silently evicts a running GUI: the emulator reconnects to
       * whoever bound last and the GUI sits there with a dead socket, looking
       * frozen. That happened every time a test harness started its own host.
       *
       * Probe first. Only a refused connection proves the file is stale.
       */
      const live = probeLiveSocket(this.socketPath);
      if (live) {
        throw new Error(
          `another IPC host is already listening on ${this.socketPath} ` +
          `(the GUI, most likely) - stop it, or pass a different socketPath`
        );
      }
      try { fs.unlinkSync(this.socketPath); } catch { /* fall through to bind */ }
    }
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    this.server = net.createServer((sock) => this._onDevice(sock));
    this.server.on('error', (err) => this.emit('error', err));
    this.server.listen(this.socketPath, () => {
      try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
      this.emit('listening', this.socketPath);
    });
    return this;
  }

  _onDevice(sock) {
    /* One emulator at a time; a new connection supersedes a stale one. */
    if (this.device && this.device !== sock) {
      try { this.device.destroy(); } catch { /* ignore */ }
    }
    this.device = sock;
    sock.setNoDelay(true);

    const feed = createFramer(
      (msg) => this._onFrame(msg),
      (err) => this.emit('error', err)
    );
    sock.on('data', feed);

    const drop = () => {
      if (this.device === sock) {
        this.device = null;
        this.emit('device-disconnect');
      }
    };
    sock.on('close', drop);
    sock.on('error', drop);

    this.emit('device-connect');
  }

  _onFrame(msg) {
    if (msg.t === 'ready') this.info = msg;
    this.emit('message', msg);
    this.emit(msg.t, msg);
  }

  get connected() { return !!this.device; }

  _send(msg) {
    if (this.device && this.device.writable) this.device.write(encode(msg));
  }

  /* ---- commands, sent to the emulator ---- */
  press(button, opts = {}) { this._send({ t: 'press', button, hold: opts.hold, ticks: opts.ticks }); }
  setButton(button, down)  { this._send({ t: 'setButton', button, down: !!down }); }
  writeHid(iface, data)    { this._send({ t: 'writeHid', iface, data: b64.pack(data) }); }
  factoryReset()           { this._send({ t: 'factoryReset' }); }
  restartDevice()          { this._send({ t: 'restartDevice' }); }
  rebuild()                { this._send({ t: 'rebuild' }); }
  getState()               { this._send({ t: 'getState' }); }

  close() {
    if (this.device) { try { this.device.destroy(); } catch { /* ignore */ } }
    this.device = null;
    if (this.server) this.server.close();
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }
}

module.exports = IpcHost;
