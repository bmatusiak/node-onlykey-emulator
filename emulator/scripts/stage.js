#!/usr/bin/env node
/*
 * stage.js - assemble the complete compile tree for the emulator.
 *
 * This mirrors arduino-1.6.5-r5-teensy_127/in-docker-build.sh, which builds by
 * COPYING everything into a scratch Arduino tree rather than compiling in
 * place:
 *
 *     cp OnlyKey-Firmware/*.c *.h  -> cores/teensy3/     (shadows core files)
 *     cp libraries/*               -> arduino/libraries/
 *
 * We do the same into emulator/.stage, then overlay emulator/core-override/
 * and apply a small set of documented textual patches. Nothing under onlykey/
 * is ever written to - per EXPLAINER.md the upstream sources stay pristine,
 * and every transformation is visible here.
 *
 * Layout produced:
 *   .stage/core/       teensy3 core + OnlyKey USB stack + our overrides
 *   .stage/libraries/  OnlyKey's vendored Arduino libraries
 *   .stage/sketch/     OnlyKey.ino
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EMU = path.resolve(__dirname, '..');
const ROOT = path.resolve(EMU, '..');
const OK = path.join(ROOT, 'onlykey');
const ARDUINO = path.join(OK, 'arduino-1.6.5-r5-teensy_127', 'arduino-1.6.5-r5');
const CORE_SRC = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'cores', 'teensy3');
const FW = path.join(OK, 'OnlyKey-Firmware');
const LIB_SRC = path.join(OK, 'libraries');
const OVERRIDE = path.join(EMU, 'core-override');

const STAGE = path.join(EMU, '.stage');
const STAGE_CORE = path.join(STAGE, 'core');
const STAGE_LIB = path.join(STAGE, 'libraries');
const STAGE_SKETCH = path.join(STAGE, 'sketch');

/*
 * Bare-metal files with no host equivalent. Each is either superseded by a
 * file in core-override/ or simply not compiled.
 */
const DROP = [
  'mk20dx128.c',        // reset handler, vector table, clock init
  'pins_teensy.c',      // -> core-override/okemu_pins.cpp (systick, GPIO)
  'analog.c',           // -> core-override/okemu_pins.cpp
  'touch.c',            // -> core-override/okemu_pins.cpp (buttons)
  'eeprom.c',           // -> core-override/okemu_eeprom.cpp (file-backed)
  'usb_dev.c',          // -> core-override/okemu_usb.cpp
  'usb_rawhid.c',       //    "
  'usb_keyboard.c',     //    "
  'usb_seremu.c',       //    "
  'usb_serial.c',       //    "
  'usb_mem.c',          // USB endpoint buffer allocator
  'usb_mouse.c', 'usb_joystick.c', 'usb_midi.c', 'usb_flightsim.c', 'usb_mtp.c',
  'serial1.c', 'serial2.c', 'serial3.c',
  'HardwareSerial1.cpp', 'HardwareSerial2.cpp', 'HardwareSerial3.cpp',
  'IntervalTimer.cpp',  // ARM NVIC periodic interrupt
  'DMAChannel.cpp',
  'AudioStream.cpp',
  'Tone.cpp',
  'avr_emulation.cpp',
  'ser_print.c',
  'math_helper.c',
  'memcpy-armv7m.S',
  'main.cpp',           // Arduino main(); the addon drives setup()/loop()
  'Makefile',
];

/*
 * Textual fixups applied to STAGED copies only.
 *
 * Two categories, both consequences of building 2015-era ARM firmware with a
 * modern host compiler:
 *
 *  1. Constructs defined in terms of Cortex-M inline assembly, which cannot be
 *     overridden from outside because the header's own #define always wins.
 *  2. Declaration inconsistencies that arm-none-eabi-g++ 4.8 accepted but
 *     GCC 14+ rejects outright.
 */
const PATCHES = [
  {
    file: 'core/kinetis.h',
    edits: [
      // `cpsid i` / `cpsie i` mask interrupts. There are none here - the
      // firmware runs on one thread against memory-backed peripherals - so
      // these reduce to the compiler barrier the surrounding flash and USB
      // buffer code actually depends on.
      ['#define __disable_irq() __asm__ volatile("CPSID i":::"memory");',
       '#define __disable_irq() __asm__ volatile("":::"memory");'],
      ['#define __enable_irq()\t__asm__ volatile("CPSIE i":::"memory");',
       '#define __enable_irq()\t__asm__ volatile("":::"memory");'],
    ],
  },
  {
    file: 'libraries/password/password.cpp',
    edits: [
      // password.cpp re-declares Profile_Offset at two different block scopes
      // with two different types (int at :118, uint8_t at :285). okcore.cpp
      // defines it as uint8_t, so the int spelling is the wrong one.
      ['extern int Profile_Offset;', 'extern uint8_t Profile_Offset;'],
    ],
  },
];

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function applyPatches() {
  let applied = 0, missing = 0;
  for (const p of PATCHES) {
    const target = path.join(STAGE, p.file);
    if (!fs.existsSync(target)) {
      console.error(`stage: WARNING - patch file absent: ${p.file}`);
      missing++;
      continue;
    }
    let text = fs.readFileSync(target, 'utf8');
    for (const [from, to] of p.edits) {
      if (!text.includes(from)) {
        console.error(`stage: WARNING - pattern not found in ${p.file}: ${from}`);
        missing++;
        continue;
      }
      text = text.split(from).join(to);
      applied++;
    }
    fs.writeFileSync(target, text);
  }
  if (missing) {
    console.error(
      'stage: a patch did not apply - upstream may have changed. Review PATCHES.'
    );
    process.exitCode = 1;
  }
  return applied;
}

function main() {
  for (const p of [CORE_SRC, FW, LIB_SRC]) {
    if (!fs.existsSync(p)) {
      console.error(`stage: missing required tree: ${p}`);
      process.exit(1);
    }
  }

  rmrf(STAGE);

  // 1. stock teensy3 core
  copyDir(CORE_SRC, STAGE_CORE);

  // 2. OnlyKey's composite USB stack + keylayouts shadow the stock core files
  let overlaid = 0;
  for (const f of fs.readdirSync(FW)) {
    if (/\.(c|h)$/.test(f)) {
      fs.copyFileSync(path.join(FW, f), path.join(STAGE_CORE, f));
      overlaid++;
    }
  }

  // 3. our host implementations of the peripheral drivers
  let overrides = 0;
  if (fs.existsSync(OVERRIDE)) {
    for (const f of fs.readdirSync(OVERRIDE)) {
      if (/\.(c|cpp|h)$/.test(f)) {
        fs.copyFileSync(path.join(OVERRIDE, f), path.join(STAGE_CORE, f));
        overrides++;
      }
    }
  }

  // 4. drop the bare-metal files
  let dropped = 0;
  for (const f of DROP) {
    const p = path.join(STAGE_CORE, f);
    if (fs.existsSync(p)) { fs.rmSync(p); dropped++; }
  }

  // 5. vendored libraries and the sketch
  copyDir(LIB_SRC, STAGE_LIB);
  copyDir(path.join(FW, 'OnlyKey'), STAGE_SKETCH);

  // 6. documented source-level fixups
  const patched = applyPatches();

  console.log(
    `stage: ${path.relative(ROOT, STAGE)}\n` +
    `  core files overlaid from OnlyKey-Firmware: ${overlaid}\n` +
    `  emulator overrides applied:                ${overrides}\n` +
    `  bare-metal files dropped:                  ${dropped}\n` +
    `  source patches applied:                    ${patched}`
  );
}

main();
