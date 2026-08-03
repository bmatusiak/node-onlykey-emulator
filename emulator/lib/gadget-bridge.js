/*
 * gadget-bridge.js - presents the emulated device to Linux as a REAL USB
 * device, via dummy_hcd + the USB gadget HID function (f_hid).
 *
 * Replaces uhid-bridge.js, and exposes the same surface
 * (start/stop/plug/unplug/plugged) so the daemon swaps one for the other.
 *
 * Why not UHID
 * ------------
 * A UHID device has no USB parent, so hidapi cannot report `manufacturer` or
 * `interface` - it returns '' and -1, always. Real software identifies an
 * OnlyKey by exactly those fields; onlykey-testing/lib/hid.js does
 *
 *     d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY' && d.interface === 3
 *
 * and python-onlykey does the same. Nothing under onlykey/ may be modified to
 * accommodate the emulator, so the emulator has to supply those fields for
 * real. Bound to dummy_hcd's virtual UDC, the gadget enumerates through the
 * kernel's USB stack and hidapi reads genuine descriptors:
 *
 *     iface=1 usagePage=0xf1d0 manufacturer="CRYPTOTRUST" product="ONLYKEY"
 *
 * Layout
 * ------
 * scripts/gadget-setup.sh (one-time, root) creates the gadget from
 * hid-descriptors.js and hands over /dev/hidg0..3 plus the UDC file. This
 * module is unprivileged: it reads and writes those nodes.
 *
 *   /dev/hidgN   read  = host -> device report (interrupt OUT)
 *                write = device -> host report (interrupt IN)
 *   $GADGET/UDC  write controller name = plug, write empty = unplug
 */
'use strict';

const fs = require('fs');

const { INTERFACES, IFACE } = require('./hid-descriptors');

/* Backing word for the synchronous sleep in _waitForEndpoints(). Never
 * signalled, so Atomics.wait() always runs the full timeout. */
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

const GADGET_DIR = process.env.OKEMU_GADGET_DIR
  || '/sys/kernel/config/usb_gadget/onlykey';
const UDC_FILE = `${GADGET_DIR}/UDC`;
const hidgPath = (n) => `/dev/hidg${n}`;

/* O_RDWR | O_NONBLOCK. Blocking reads would each hold a libuv threadpool slot
 * (default 4) for as long as the host stays quiet, which with four interfaces
 * starves the pool and stalls unrelated fs work. */
const OPEN_FLAGS = fs.constants.O_RDWR | fs.constants.O_NONBLOCK;

/* Enough to ride out a long debug burst; far below anything that could grow
 * without bound if the host stops polling entirely. */
const MAX_TX_QUEUE = 4096;

class GadgetDevice {
  constructor(spec, onOutput) {
    this.spec = spec;
    this.onOutput = onOutput;
    this.fd = null;
    /* A read never returns more than one report. */
    this.readBuf = Buffer.alloc(Math.max(spec.outSize, spec.inSize, 64));
    this.txQueue = [];
    this.draining = false;
    this.retryPending = false;
    this.txDropped = 0;
  }

  start() {
    const path = hidgPath(this.spec.iface);
    try {
      this.fd = fs.openSync(path, OPEN_FLAGS);
    } catch (err) {
      throw new Error(
        `cannot open ${path} (${err.code}) - run scripts/gadget-setup.sh once`
      );
    }
    this._read();
  }

  _read() {
    if (this.fd === null) return;
    fs.read(this.fd, this.readBuf, 0, this.readBuf.length, null, (err, n) => {
      if (this.fd === null) return;
      if (err) {
        /*
         * EAGAIN  - nothing queued, normal.
         * ESHUTDOWN/ECONNRESET - host detached (UDC unbound); keep polling so
         *           the same fd resumes when it is bound again.
         */
        if (err.code === 'EAGAIN' || err.code === 'ESHUTDOWN'
            || err.code === 'ECONNRESET') {
          return setTimeout(() => this._read(), 2);
        }
        return;
      }
      if (n > 0) this.onOutput(Buffer.from(this.readBuf.subarray(0, n)));
      /* Yield rather than recursing straight back in, so a chatty host cannot
       * monopolise the loop. */
      setImmediate(() => this._read());
    });
  }

  /**
   * device -> host
   *
   * Queued rather than written straight through. f_hid's interrupt-IN queue is
   * shallow, so a write returns EAGAIN whenever the firmware produces reports
   * faster than the host polls the endpoint. Treating that as "nobody is
   * listening" and discarding the report loses real output: the debug burst
   * after a PIN commit (Curve25519, AES-GCM, flash writes, hex dumps of all of
   * it) reliably outran the host, and the dropped reports included the
   * step acknowledgements the test harness waits on - so setup timed out on a
   * step the firmware had in fact completed.
   *
   * EAGAIN means "not yet", so retry until it fits.
   */
  send(data) {
    if (this.fd === null) return;
    /*
     * Bounded, so a device left talking to nobody cannot grow this forever.
     * Dropping the OLDEST keeps the most recent output, which is what anyone
     * reading the console actually wants.
     */
    if (this.txQueue.length >= MAX_TX_QUEUE) {
      this.txQueue.shift();
      this.txDropped++;
    }
    this.txQueue.push(data);
    this._drain();
  }

  _drain() {
    /*
     * retryPending is not optional bookkeeping. send() calls _drain() for every
     * report, so without it each write during an EAGAIN backoff scheduled ANOTHER
     * timer: under a sustained debug flood (the firmware's lockout loop prints
     * continuously) pending timers accumulated in the thousands and the daemon
     * died with "JavaScript heap out of memory", which pm2 then respawned into a
     * flapping loop. One timer outstanding at a time.
     */
    if (this.fd === null || this.draining || this.retryPending) return;
    this.draining = true;

    while (this.txQueue.length) {
      try {
        fs.writeSync(this.fd, this.txQueue[0]);
        this.txQueue.shift();
      } catch (err) {
        if (err.code === 'EAGAIN') {
          /* Endpoint queue full - let the host drain it and come back. */
          this.draining = false;
          this.retryPending = true;
          setTimeout(() => { this.retryPending = false; this._drain(); }, 1);
          return;
        }
        /* ESHUTDOWN/ENODEV/EIO: genuinely unplugged. Discard and stop; the
         * host is gone, and stale reports must not surface on re-plug. */
        if (['ESHUTDOWN', 'ENODEV', 'EIO'].includes(err.code)) {
          this.txQueue.length = 0;
          break;
        }
        this.draining = false;
        throw err;
      }
    }
    this.draining = false;
  }

  destroy() {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    this.txQueue.length = 0;
    this.draining = false;
    this.retryPending = false;
    try { fs.closeSync(fd); } catch { /* going away anyway */ }
  }
}

class GadgetBridge {
  constructor(emu) {
    this.emu = emu;
    this.devices = new Map();
    this.udcName = null;
  }

  start() {
    if (!fs.existsSync(UDC_FILE)) {
      throw new Error(
        `${UDC_FILE} not found - run  sudo ./scripts/gadget-setup.sh  once`
      );
    }
    /* Remember which controller we are bound to, so unplug/plug can restore
     * it. If the gadget is already unbound, fall back to the only UDC there. */
    this.udcName = fs.readFileSync(UDC_FILE, 'utf8').trim()
      || fs.readdirSync('/sys/class/udc')[0];

    /*
     * Attach to the bus BEFORE opening the endpoints: f_hid creates /dev/hidgN
     * in its bind path, so while the gadget is unbound those nodes do not
     * exist at all.
     *
     * Binding here is what makes a firmware reset a real re-enumeration.
     * CPU_RESTART() exits this process and pm2 respawns it; on hardware that
     * reset drops the device off the bus and it comes back. Leaving the gadget
     * bound across the respawn instead presented a device that looked
     * continuously present but answered nothing for the ~2s the daemon was
     * down - and f_hid accepts host writes into its OUT queue with nobody
     * reading, so a client's liveness probe succeeded and it sent into the
     * void. That is how PIN entry straight after a restart lost its leading
     * digits, failed, and after three such attempts wedged the device in
     * exceeded_login_attempts(). See detachBus() for the other half.
     */
    if (!this.plugged) this._attachBus();
    this._waitForEndpoints();
    this._openDevices();

    /* Device -> host. onStream carries every interface; forward the outbound
     * half to the node for that interface. */
    this._onStream = ({ buffer, iface, dir }) => {
      if (dir !== 'out') return;
      const dev = this.devices.get(iface);
      if (!dev) return;

      /*
       * HID input reports are fixed-size: the host reads exactly the count the
       * descriptor declares. The firmware writes SEREMU text at its natural
       * length ("Enter PIN\r\n" is 11 bytes) and real hardware packs that into
       * full 64-byte packets. Sending the short buffer instead means hidapi
       * readers see nothing at all.
       */
      const size = dev.spec.inSize;
      for (let off = 0; off < buffer.length; off += size) {
        const chunk = Buffer.alloc(size);
        buffer.copy(chunk, 0, off, Math.min(off + size, buffer.length));
        dev.send(chunk);
      }
    };
    this.emu.on('stream', this._onStream);
    return this;
  }

  _openDevices() {
    for (const spec of INTERFACES) {
      const dev = new GadgetDevice(spec, (data) => {
        if (!spec.writable) return;   /* keyboard OUT is just LED state */
        this.emu.writeHid(data, spec.iface);
      });
      dev.start();
      this.devices.set(spec.iface, dev);
    }
  }

  /*
   * The nodes appear asynchronously after bind, and udev has to apply the rule
   * that makes them ours to open.
   *
   * The budget has to cover a whole restart cycle, not just the bind: measured
   * on this machine a CPU_RESTART() takes ~5.8s from the request to the device
   * answering again (unbind, pm2 respawn, node + addon load, firmware setup,
   * rebind). An earlier 3s cap expired first, _openDevices() threw, the bridge
   * reported unavailable, and the device never came back at all.
   */
  _waitForEndpoints(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    const paths = INTERFACES.map((s) => hidgPath(s.iface));
    for (;;) {
      if (paths.every((p) => fs.existsSync(p))) return true;
      if (Date.now() >= deadline) return false;
      /* Synchronous wait: start() is synchronous and its caller expects it to
       * have either worked or thrown by the time it returns. Atomics.wait on a
       * never-signalled word is the cheap way to block a thread for a fixed
       * interval without spinning the CPU. */
      Atomics.wait(SLEEP_WORD, 0, 0, 25);
    }
  }

  _attachBus() {
    if (!this.udcName) return false;
    try { fs.writeFileSync(UDC_FILE, `${this.udcName}\n`); return true; }
    catch { return false; }
  }

  /**
   * Drop off the bus without stopping anything else.
   *
   * Called on the way out of a firmware restart, so the host sees the device
   * genuinely disappear and re-enumerate rather than sit there unresponsive.
   * Distinct from power.js's unplug, which also stops the process.
   */
  detachBus() {
    if (!this.plugged) return false;
    try { fs.writeFileSync(UDC_FILE, '\n'); return true; }
    catch { return false; }
  }

  stop() {
    if (this._onStream) this.emu.off('stream', this._onStream);
    for (const dev of this.devices.values()) dev.destroy();
    this.devices.clear();
  }

  /*
   * Plug / unplug, modelling the USB cable rather than the process.
   *
   * Unbinding the gadget from the UDC is a real bus-level disconnect: the host
   * side sees the device removed and tears down its hidraw nodes, so every
   * client - browsers, python-onlykey, the test harness - observes a genuine
   * unplug. This is more faithful than the UHID bridge managed, where the
   * device node simply vanished. The firmware thread keeps running with its
   * RAM intact; a power cycle is the separate restart path.
   */
  get plugged() {
    try { return fs.readFileSync(UDC_FILE, 'utf8').trim().length > 0; }
    catch { return false; }
  }

  unplug() {
    if (!this.plugged) return false;
    for (const dev of this.devices.values()) dev.destroy();
    this.devices.clear();
    fs.writeFileSync(UDC_FILE, '\n');
    return true;
  }

  plug() {
    if (this.plugged) return false;
    this._attachBus();
    this._waitForEndpoints();
    this._openDevices();
    return true;
  }
}

module.exports = GadgetBridge;
module.exports.GADGET_DIR = GADGET_DIR;
module.exports.IFACE = IFACE;
