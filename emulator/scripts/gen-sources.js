#!/usr/bin/env node
/*
 * gen-sources.js - emits emulator/sources.gypi.
 *
 * gyp cannot glob, and the firmware pulls in ~20 vendored libraries, so the
 * file list is generated instead of hand-maintained. Run via `npm run stage`.
 *
 * EXCLUDE holds files that must not be compiled as their own translation unit:
 * bare-metal drivers we replace, and the mlkem/mldsa `src/` trees, which the
 * monolithic mlkem_native.c / mldsa_native.c #include wholesale (compiling
 * them separately would duplicate every symbol - see libraries/onlykey/BUILD.md).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EMU = path.resolve(__dirname, '..');
const ROOT = path.resolve(EMU, '..');
const OK = path.join(ROOT, 'onlykey');
const STAGE = path.join(EMU, '.stage');
const LIB = path.join(STAGE, 'libraries');
const ARDUINO = path.join(OK, 'arduino-1.6.5-r5-teensy_127', 'arduino-1.6.5-r5');
const TLIB = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'libraries');
const STAGE_CORE = path.join(STAGE, 'core');

const SRC_RE = /\.(c|cpp)$/;

/* Directories walked non-recursively unless listed in RECURSE. */
const LIB_DIRS = [
  'onlykey', 'Crypto', 'SoftTimer', 'T3Mac', 'base64', 'password',
  'sha1', 'sha256', 'totp', 'tweetnacl', 'justhashtweetnacl', 'uECC',
  'ykcore', 'yksim', 'randombytes', 'fido2', 'tinycbor', 'mbedtls-2.4.0',
];

const EXCLUDE = new Set([
  /* replaced by emulator/src or core-override */
  'flashkinetis.cpp',          // -> emulator/src/okemu_flash.cpp
  'Adafruit_NeoPixel.cpp',     // -> emulator/shim/Adafruit_NeoPixel.h
  'esp8266.c',
  /* the Teensy core's own entry point; the addon drives setup()/loop() */
  'main.cpp',
  /*
   * The N-API layer is its own gyp target: node-addon-api requires C++17,
   * while the firmware is built at gnu++11 - the standard it was written
   * against - so the two cannot share a compile line.
   */
  'addon.cpp',
]);

/* Path fragments that disqualify a file wherever it appears. */
const EXCLUDE_PATH = [
  `${path.sep}examples${path.sep}`,
  `${path.sep}test${path.sep}`,
  `${path.sep}tests${path.sep}`,
  /* #included by the monolithic mlkem_native.c / mldsa_native.c */
  `${path.sep}utility${path.sep}src${path.sep}`,
  `${path.sep}utility${path.sep}mldsa_src${path.sep}`,
];

function walk(dir, recurse, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recurse) walk(p, recurse, out);
      continue;
    }
    if (!SRC_RE.test(ent.name)) continue;
    if (EXCLUDE.has(ent.name)) continue;
    if (EXCLUDE_PATH.some((frag) => p.includes(frag))) continue;
    out.push(p);
  }
  return out;
}

const sources = [];

/* 1. emulator's own sources */
walk(path.join(EMU, 'src'), false, sources);

/* 2. staged Teensy core (already has OnlyKey's USB stack + our overrides
 *    overlaid, and the bare-metal files removed) */
walk(STAGE_CORE, false, sources);

/* 3. OnlyKey's vendored libraries */
for (const d of LIB_DIRS) walk(path.join(LIB, d), false, sources);
/* the PQC monoliths live one level down */
walk(path.join(LIB, 'onlykey', 'utility'), false, sources);

/* 4. Arduino Time library (firmware calls now()) */
walk(path.join(TLIB, 'Time'), false, sources);

const rel = sources
  .map((p) => path.relative(EMU, p))
  .sort();

const gypi = {
  variables: {
    okemu_sources: rel,
  },
};

const outPath = path.join(EMU, 'sources.gypi');
fs.writeFileSync(outPath, JSON.stringify(gypi, null, 2) + '\n');
console.log(`gen-sources: ${rel.length} translation units -> ${path.relative(ROOT, outPath)}`);
