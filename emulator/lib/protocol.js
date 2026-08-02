/*
 * protocol.js - the wire format shared by the IPC server and its clients.
 *
 * Newline-delimited JSON over a Unix domain socket. Binary payloads travel as
 * base64 strings, since JSON has no byte type and the volumes here (64-byte
 * reports, short debug lines) make the encoding overhead irrelevant.
 *
 * Every frame is {t: <type>, ...}. Server -> client frames are events; client
 * -> server frames are commands. Both directions are fire-and-forget except
 * `getState`, which is answered with a `state` event.
 */
'use strict';

const os = require('os');
const path = require('path');

/*
 * Default socket path. XDG_RUNTIME_DIR is per-user and tmpfs-backed, which is
 * the right home for a socket; it also means the socket is only reachable by
 * this user, which is the access control we want now that nothing runs as root.
 */
function defaultSocketPath() {
  const runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(runtime, 'onlykey-emulator.sock');
}

/* ---- server -> client ---------------------------------------------------
 *  ready    {version, storageDir, uhid}   sent immediately on connect
 *  state    {led, uhid, started}          full snapshot (reply to getState)
 *  led      {pixels:[{r,g,b}]}
 *  keyboard {data}                        base64 8-byte HID report
 *  log      {text}                        SEREMU debug output
 *  hid      {iface, name, dir, data}      any HID traffic, both directions
 *  restart  {}                            firmware ran CPU_RESTART()
 * ---- client -> server ---------------------------------------------------
 *  press        {button, long}
 *  setButton    {button, down}            raw analog pad
 *  writeHid     {iface, data}             base64
 *  factoryReset {}
 *  restartDevice{}
 *  rebuild      {}                        recompile, then exit for pm2
 *  getState     {}
 */

/** Splits a socket byte stream into JSON frames. */
function createFramer(onFrame, onError) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        if (onError) onError(new Error(`bad IPC frame: ${err.message}`));
        continue;
      }
      onFrame(msg);
    }
    /* A peer that never sends a newline would otherwise grow this forever. */
    if (buf.length > 1 << 20) {
      buf = '';
      if (onError) onError(new Error('IPC frame exceeded 1 MiB, buffer dropped'));
    }
  };
}

function encode(msg) {
  return JSON.stringify(msg) + '\n';
}

const b64 = {
  pack: (buffer) => Buffer.from(buffer).toString('base64'),
  unpack: (str) => Buffer.from(str, 'base64'),
};

module.exports = { defaultSocketPath, createFramer, encode, b64 };
