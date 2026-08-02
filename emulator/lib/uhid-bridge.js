/*
 * uhid-bridge.js - presents the emulated OnlyKey to the OS as real HID devices.
 *
 * The physical OnlyKey is one USB device with four HID interfaces (three in a
 * production build - SEREMU is DEBUG-only). Linux gives each interface its own
 * /dev/hidrawN node, and clients find the one they want by usage page:
 * hidapi/WebAuthn look for 0xF1D0, python-onlykey and the OnlyKey app look for
 * 0xFFAB. So we create four separate UHID devices sharing OnlyKey's VID/PID,
 * each carrying the interface's report descriptor byte-for-byte as it appears
 * in OnlyKey-Firmware/usb_desc.c. Anything less and clients fail to enumerate.
 *
 * Requires /dev/uhid to be writable - see scripts/setup-permissions.sh. This
 * module throws if it is not, and the daemon treats that as non-fatal.
 */
'use strict';

const fs = require('fs');
const emuModule = require('../index');
const { IFACE } = emuModule;
const native = require('../build/Release/onlykey_emulator.node');

/* linux/uhid.h event types */
const UHID_CREATE2 = 11;
const UHID_DESTROY = 1;
const UHID_START = 2;
const UHID_STOP = 3;
const UHID_OPEN = 4;
const UHID_CLOSE = 5;
const UHID_OUTPUT = 6;
const UHID_GET_REPORT = 9;
const UHID_GET_REPORT_REPLY = 10;
const UHID_INPUT2 = 12;
const UHID_SET_REPORT = 13;
const UHID_SET_REPORT_REPLY = 14;

const VENDOR_ID = 0x1d50;
const PRODUCT_ID = 0x60fc;

/*
 * Identity strings, matched to real hardware because clients filter on them.
 *
 * python-onlykey's Client._connect() accepts a device only when
 *   (vendor_id, product_id) in DEVICE_IDS
 *   and serial_number == '1000000000'
 *   and (usage_page == 0xffab or interface_number == 2)
 * so the serial has to be exactly this - it is the same value
 * scripts/emulate-onlykey-hid.sh writes into the gadget's serialnumber
 * string, and what the firmware reports over USB.
 *
 * hidapi surfaces UHID's `name` as product_string and `uniq` as
 * serial_number. All four interfaces share them, exactly as the four
 * interfaces of one physical device do; the usage page is what tells them
 * apart.
 */
const PRODUCT_NAME = 'ONLYKEY';
const SERIAL_NUMBER = '1000000000';

/* ---------------------------------------------------------------------------
 * Report descriptors, transcribed from OnlyKey-Firmware/usb_desc.c.
 * ------------------------------------------------------------------------ */

/* keyboard_report_desc - boot keyboard, 8-byte reports */
const KEYBOARD_DESC = Buffer.from([
  0x05, 0x01,        // Usage Page (Generic Desktop)
  0x09, 0x06,        // Usage (Keyboard)
  0xA1, 0x01,        // Collection (Application)
  0x05, 0x07,        //   Usage Page (Key Codes)
  0x19, 0xE0, 0x29, 0xE7,
  0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08,
  0x81, 0x02,        //   Input - modifier byte
  0x95, 0x01, 0x75, 0x08,
  0x05, 0x0C, 0x09, 0xB8,
  0x81, 0x01,        //   Input - media keys
  0x95, 0x05, 0x75, 0x01,
  0x05, 0x08, 0x19, 0x01, 0x29, 0x05,
  0x91, 0x02,        //   Output - LED report
  0x95, 0x01, 0x75, 0x03,
  0x91, 0x01,        //   Output - LED padding
  0x95, 0x06, 0x75, 0x08,
  0x15, 0x00, 0x25, 0x7F,
  0x05, 0x07, 0x19, 0x00, 0x29, 0x7F,
  0x81, 0x00,        //   Input - 6 keycodes
  /*
   * 8-byte Feature report. Not decoration: OnlyKey's usb_dev.c uses SET_REPORT
   * on this interface as a side channel, filling setBuffer[] which
   * process_setreport() then consumes. The OnlyKey app sends configuration
   * this way. Omitting it makes the host unable to send those packets at all.
   * Matches scripts/emulate-onlykey-hid.sh, captured from real hardware.
   */
  0x09, 0x76, 0x95, 0x08, 0x75, 0x08, 0xB1, 0x02,
  0xC0,
]);

/* rawhid_report_desc / rawhid_report_desc2 differ only in usage page+usage. */
function rawhidDesc(usagePage, usage) {
  return Buffer.from([
    0x06, usagePage & 0xFF, (usagePage >> 8) & 0xFF,
    0x09, usage,
    0xA1, 0x01,                    // Collection (Application)
    0x09, 0x20,                    //   Usage (input data)
    0x15, 0x00, 0x26, 0xFF, 0x00,
    0x75, 0x08, 0x95, 0x40,        //   64 bytes
    0x81, 0x02,                    //   Input
    0x09, 0x21,                    //   Usage (output data)
    0x15, 0x00, 0x26, 0xFF, 0x00,
    0x75, 0x08, 0x95, 0x40,        //   64 bytes
    0x91, 0x02,                    //   Output
    0xC0,
  ]);
}

/* seremu_report_desc - TX 64, RX 32, vendor page 0xFFC9 */
const SEREMU_DESC = Buffer.from([
  0x06, 0xC9, 0xFF,  // Usage Page 0xFFC9
  0x09, 0x04,        // Usage 0x04
  0xA1, 0x5C,        // Collection 0x5C
  0x75, 0x08,
  0x15, 0x00, 0x26, 0xFF, 0x00,
  0x95, 64,          // SEREMU_TX_SIZE
  0x09, 0x75, 0x81, 0x02,   // Input
  0x95, 32,          // SEREMU_RX_SIZE
  0x09, 0x76, 0x91, 0x02,   // Output
  0x95, 0x04,
  0x09, 0x76, 0xB1, 0x02,   // Feature
  0xC0,
]);

/*
 * inSize / outSize are the declared report counts, and they are NOT always
 * equal: SEREMU is asymmetric (usb_desc.h SEREMU_TX_SIZE 64, SEREMU_RX_SIZE
 * 32). A host reads exactly inSize bytes per input report, so sending 32 where
 * the descriptor says 64 means hidapi readers see nothing at all.
 */
const INTERFACES = [
  { iface: IFACE.KEYBOARD, name: 'Keyboard', desc: KEYBOARD_DESC,
    inSize: 8, outSize: 8, writable: false },
  { iface: IFACE.FIDO, name: 'RawHID (FIDO)', desc: rawhidDesc(0xF1D0, 0x01),
    inSize: 64, outSize: 64, writable: true },
  { iface: IFACE.VENDOR, name: 'RawHID2 (vendor)', desc: rawhidDesc(0xFFAB, 0x02),
    inSize: 64, outSize: 64, writable: true },
  { iface: IFACE.SEREMU, name: 'SEREMU (debug)', desc: SEREMU_DESC,
    inSize: 64, outSize: 32, writable: true },
];

/*
 * struct uhid_create2_req, laid out as the kernel expects:
 *   name[128] phys[64] uniq[64] rd_size(u16) bus(u16)
 *   vendor(u32) product(u32) version(u32) country(u32) rd_data[4096]
 * The event type is a u32 in front. Fixed-size fields must be written at exact
 * offsets - the kernel reads the struct positionally, not as a stream.
 */
function buildCreate2(name, uniq, desc) {
  const buf = Buffer.alloc(4 + 128 + 64 + 64 + 2 + 2 + 4 + 4 + 4 + 4 + 4096);
  let o = 0;
  buf.writeUInt32LE(UHID_CREATE2, o); o += 4;
  buf.write(name, o, 128, 'utf8'); o += 128;
  buf.write('onlykey-emulator', o, 64, 'utf8'); o += 64;
  buf.write(uniq, o, 64, 'utf8'); o += 64;
  buf.writeUInt16LE(desc.length, o); o += 2;
  buf.writeUInt16LE(0x03, o); o += 2;        // BUS_USB
  buf.writeUInt32LE(VENDOR_ID, o); o += 4;
  buf.writeUInt32LE(PRODUCT_ID, o); o += 4;
  buf.writeUInt32LE(0, o); o += 4;           // version
  buf.writeUInt32LE(0, o); o += 4;           // country
  desc.copy(buf, o);
  return buf;
}

/*
 * Reconcile the two conventions clients use when writing a HID report.
 *
 * UHID hands us the write buffer verbatim - the kernel does not strip
 * anything - so what arrives depends entirely on the client:
 *
 *   hidapi's documented convention prepends a report-number byte (0 for
 *   devices with no report IDs), giving reportSize + 1 bytes.
 *
 *   python-onlykey does that only on Windows; on Linux its MESSAGE_HEADER is
 *   [255,255,255,255] and it writes exactly 64 bytes with no prefix
 *   (client.py, MAX_INPUT_REPORT_SIZE).
 *
 * None of OnlyKey's descriptors declare report IDs, so on real hardware the
 * whole buffer is the payload. Stripping unconditionally shifted
 * python-onlykey's header to FF FF FF and the firmware ignored the packet;
 * never stripping breaks the hidapi convention instead. So strip only the
 * one case that is unambiguous - an extra leading zero byte.
 */
function stripReportId(data, reportSize) {
  if (data.length === reportSize + 1 && data[0] === 0x00) return data.subarray(1);
  return data;
}

class UhidDevice {
  constructor(spec, onOutput, hooks = {}) {
    this.spec = spec;
    this.onOutput = onOutput;
    this.hooks = hooks;
    this.fd = null;
    this.open = false;
    this.readBuf = Buffer.alloc(4380);
    this._reading = false;
  }

  start() {
    this.fd = fs.openSync('/dev/uhid', 'r+');
    fs.writeSync(this.fd,
      buildCreate2(PRODUCT_NAME, SERIAL_NUMBER, this.spec.desc));
    this._read();
  }

  _read() {
    if (this.fd === null) return;
    this._reading = true;
    fs.read(this.fd, this.readBuf, 0, this.readBuf.length, null, (err, n) => {
      this._reading = false;
      if (this.fd === null) return;
      if (err) {
        /* EAGAIN just means nothing queued yet; anything else and we stop. */
        if (err.code === 'EAGAIN') return setTimeout(() => this._read(), 5);
        return;
      }
      if (n > 0) this._onEvent(this.readBuf.subarray(0, n));
      this._read();
    });
  }

  _onEvent(ev) {
    const type = ev.readUInt32LE(0);
    switch (type) {
      case UHID_START: break;
      case UHID_OPEN:  this.open = true; break;
      case UHID_CLOSE: this.open = false; break;
      case UHID_STOP:  break;
      case UHID_OUTPUT: {
        /*
         * struct uhid_output_req: data[4096] size(u16) rtype(u8), after the
         * u32 type. This is host -> device: a client wrote a report to us.
         *
         * data[0] is the report NUMBER, not payload. Our descriptors declare
         * no report IDs, so hidraw requires callers to prepend a 0 byte and
         * passes it straight through - a 64-byte RawHID report arrives here
         * as 65 bytes beginning 0x00. Forwarding that verbatim shifts every
         * field by one and the firmware silently ignores the packet, which is
         * exactly how this presented: writes accepted, nothing ever parsed.
         */
        const size = ev.readUInt16LE(4 + 4096);
        if (size > 0) this.onOutput(stripReportId(ev.subarray(4, 4 + size),
                                                  this.spec.outSize));
        break;
      }

      /*
       * Control transfers. On real hardware these are USB SET_REPORT /
       * GET_REPORT on endpoint 0; OnlyKey uses them on the keyboard interface
       * as its Yubikey OTP / HMAC-SHA1 channel. The kernel expects a reply
       * frame for each, tagged with the request id, and blocks the caller
       * until it arrives - so both paths must always answer.
       */
      case UHID_SET_REPORT: {
        // struct uhid_set_report_req: id(u32) rnum(u8) rtype(u8) size(u16) data[]
        const id = ev.readUInt32LE(4);
        const size = ev.readUInt16LE(4 + 4 + 1 + 1);
        const data = ev.subarray(4 + 4 + 1 + 1 + 2, 4 + 4 + 1 + 1 + 2 + size);
        let err = 0;
        try {
          if (this.hooks.onSetReport) this.hooks.onSetReport(data);
          else if (this.spec.writable) this.onOutput(data);
        } catch {
          err = 1;
        }
        const reply = Buffer.alloc(4 + 4 + 2);
        reply.writeUInt32LE(UHID_SET_REPORT_REPLY, 0);
        reply.writeUInt32LE(id, 4);
        reply.writeUInt16LE(err, 8);
        this._write(reply);
        break;
      }

      case UHID_GET_REPORT: {
        // struct uhid_get_report_req: id(u32) rnum(u8) rtype(u8)
        const id = ev.readUInt32LE(4);
        let payload = Buffer.alloc(0);
        let err = 0;
        try {
          if (this.hooks.onGetReport) payload = this.hooks.onGetReport();
          else err = 1;
        } catch {
          err = 1;
        }
        // struct uhid_get_report_reply_req: id(u32) err(u16) size(u16) data[]
        const reply = Buffer.alloc(4 + 4 + 2 + 2 + payload.length);
        reply.writeUInt32LE(UHID_GET_REPORT_REPLY, 0);
        reply.writeUInt32LE(id, 4);
        reply.writeUInt16LE(err, 8);
        reply.writeUInt16LE(payload.length, 10);
        payload.copy(reply, 12);
        this._write(reply);
        break;
      }

      default: break;
    }
  }

  /** device -> host */
  send(data) {
    const payload = Buffer.alloc(4 + 2 + data.length);
    payload.writeUInt32LE(UHID_INPUT2, 0);
    payload.writeUInt16LE(data.length, 4);
    data.copy(payload, 6);
    this._write(payload);
  }

  _write(payload) {
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, payload);
    } catch (err) {
      /* ENODEV/EIO: the client detached between our check and the write. */
      if (err.code !== 'ENODEV' && err.code !== 'EIO') throw err;
    }
  }

  destroy() {
    if (this.fd === null) return;
    try {
      const ev = Buffer.alloc(4);
      ev.writeUInt32LE(UHID_DESTROY, 0);
      fs.writeSync(this.fd, ev);
    } catch { /* going away anyway */ }
    try { fs.closeSync(this.fd); } catch { /* ignore */ }
    this.fd = null;
  }
}

class UhidBridge {
  constructor(emu) {
    this.emu = emu;
    this.devices = new Map();
  }

  start() {
    /* Fail fast and clearly if the udev rule has not been installed. */
    try {
      fs.closeSync(fs.openSync('/dev/uhid', 'r+'));
    } catch (err) {
      throw new Error(
        `/dev/uhid not writable (${err.code}) - run scripts/setup-permissions.sh once`
      );
    }

    this._createDevices();

    /* Device -> host. onStream carries every interface; forward only the
     * outbound half, to the node representing that interface. */
    this._onStream = ({ buffer, iface, dir }) => {
      if (dir !== 'out') return;
      const dev = this.devices.get(iface);
      if (!dev) return;

      /*
       * HID input reports are fixed-size: a host reads exactly the count the
       * descriptor declares. The firmware writes SEREMU text at its natural
       * length ("Enter PIN\r\n" is 11 bytes), and on real hardware
       * usb_seremu_write() packs that into full 64-byte USB packets. Passing
       * the short buffer straight through meant hidapi readers - the test
       * harness's SeremuChannel among them - saw nothing at all, even though
       * the IPC stream showed the text fine.
       *
       * Split into descriptor-sized chunks, zero-padded, exactly as the device
       * puts them on the wire.
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

  _createDevices() {
    for (const spec of INTERFACES) {
      /*
       * The keyboard interface carries OnlyKey's Yubikey OTP / HMAC-SHA1
       * protocol over control transfers, handled natively (a port of
       * usb_dev.c's usb_setup) so it shares setBuffer/getBuffer with the
       * firmware. Its interrupt-OUT reports are just LED state, which the
       * firmware does not consume.
       */
      const hooks = spec.iface === IFACE.KEYBOARD ? {
        onSetReport: (data) => native.kbdSetReport(data),
        onGetReport: () => native.kbdGetReport(),
      } : {};

      const dev = new UhidDevice(spec, (data) => {
        if (!spec.writable) return;
        this.emu.writeHid(data, spec.iface);
      }, hooks);
      dev.start();
      this.devices.set(spec.iface, dev);
    }
  }

  stop() {
    if (this._onStream) this.emu.off('stream', this._onStream);
    for (const dev of this.devices.values()) dev.destroy();
    this.devices.clear();
  }

  /*
   * Plug / unplug, modelling the USB cable rather than the process.
   *
   * Destroying the UHID devices makes the OS tear down the hidraw nodes, so
   * every client - browsers, python-onlykey, the test harness - sees the key
   * genuinely disappear, which is what TC-07's "real physical unplug" needs.
   * The firmware thread keeps running with its RAM state intact; a true power
   * cycle is the separate restart path.
   *
   * Node numbers are reassigned on re-plug, exactly as they are on real
   * re-enumeration, so clients must re-enumerate rather than reuse a handle.
   */
  get plugged() { return this.devices.size > 0; }

  unplug() {
    if (!this.plugged) return false;
    for (const dev of this.devices.values()) dev.destroy();
    this.devices.clear();
    return true;
  }

  plug() {
    if (this.plugged) return false;
    this._createDevices();
    return true;
  }
}

module.exports = UhidBridge;
