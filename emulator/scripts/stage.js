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
 *  3. Non-void functions with a path that falls off the end. See MISSING_RETURNS.
 */

/*
 * FALLING OFF THE END OF A NON-VOID FUNCTION.
 *
 * Three firmware functions have a control path that reaches the closing brace
 * without a return. That is undefined behaviour, and the two compilers make
 * wildly different choices about it:
 *
 *   arm-none-eabi-g++ 4.8 -Os  emits the ordinary epilogue and returns
 *                              whatever happens to be in r0. Garbage, but the
 *                              stack is intact and the caller resumes.
 *   x86-64 GCC 14 -O2          treats the end as unreachable and emits NO
 *                              epilogue and NO ret. Control simply runs into
 *                              whatever basic block was laid out next.
 *
 * For ctap_flash() that is not a subtle difference. GCC laid the tail of the
 * mode==2 body directly ahead of the shared "erase failed" block and closed
 * the loop with a jump back into the middle of the function:
 *
 *     bd0e: call flashEraseSector
 *     bd1a: test %eax,%eax
 *     bd1c: jne  bd91                 <- erase failed -> print "NOT "
 *     bd1e: call println("successful")
 *     ...   call okcore_flashset_common / print "CTAP address =" / "CTAP value ="
 *     bd91: call println("NOT ")      <- fallen off the end, lands here
 *     bda4: jmp  bd1e                 <- ...and loops, forever
 *
 * ctap_flash(mode 2) is the store-resident-key path, so this fired the moment
 * a FIDO2 registration was approved: the firmware thread spun at 100% CPU
 * inside that three-print loop, never returned to ctap_make_credential(), and
 * never sent a CTAPHID response - which the browser reported as a plain
 * "response timeout" from the security-key prompt. The pm2 log is the loop,
 * 3.4 million lines of it, after a single "CTAP Flash mode= 2".
 *
 * The other two are the same defect on paths that had not yet been hit. They
 * are fixed here too rather than left as landmines: each is one edge of the
 * same FIDO2 request handling.
 *
 * Returning the value each function's own successful path returns reproduces
 * the ARM build's intent without inventing behaviour - and in every case the
 * callers of the affected path ignore the result:
 *
 *   ctap_flash            mode 2 (write RK) is called for effect;
 *                         device.cpp:447 and okcore.cpp:7067 discard it. Only
 *                         mode 3 is read (device.cpp:233) and that returns.
 *   ctap_atomic_count     the amount != 0 paths come from ctaphid.cpp:835,
 *                         which ignores the result. Every reader passes 0.
 *   send_stored_response  falls through when profilemode is
 *                         NONENCRYPTEDPROFILE; ret is still its initial 0.
 *
 * Worth knowing for the next one of these: the firmware target compiles with
 * -w, so -Wreturn-type never printed. To re-scan, drop -w from binding.gyp's
 * okemu_firmware cflags and grep the build for "control reaches end".
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
    file: 'libraries/onlykey/okcore.cpp',
    edits: [
      // HW_MODEL() returns a pointer to a stack-allocated VLA:
      //     char out[strlen(in)+2];  ...  return (char*)out;
      // The array dies with the frame, so the caller reads freed stack. On the
      // MK20DX256 (bare metal, -Os, one thread, no red zone reuse before the
      // callee runs) the bytes survive long enough for hidprint() to copy them,
      // so the device works. Hosted, the very next call clobbers that frame and
      // hidprint() dereferences null - which crashed the daemon on any status
      // reply, e.g. python-onlykey's settime.
      //
      // A function-static buffer has the same single-threaded lifetime the
      // firmware already assumes (the result is consumed immediately by
      // hidprint) and removes the UB. Bounded so a long input cannot overrun.
      ['\tchar out[strlen(in)+2];\n\tmemcpy(out,in,strlen(in));',
       '\tstatic char out[64];\n\tsize_t okemu_n = strlen(in);\n' +
       '\tif (okemu_n > sizeof(out) - 2) okemu_n = sizeof(out) - 2;\n' +
       '\tmemcpy(out, in, okemu_n);'],
      ['out[sizeof(out)-2]', 'out[okemu_n]'],
      ['\tout[sizeof(out)-1] = 0;', '\tout[okemu_n + 1] = 0;'],

      // Same null-pointer-as-zero pattern as in OnlyKey.ino below.
      ['okeeprom_eeset_timeout(0);',
       '{ uint8_t okemu_zero = 0; okeeprom_eeset_timeout(&okemu_zero); }'],

      /*
       * THE 32-BIT ASSUMPTION. Every flash field the firmware owns is read and
       * written through these two loops, which walk storage with
       *
       *     unsigned long *adr;  ...  adr++;
       *
       * On the MK20DX256 (ILP32) that steps 4 bytes - one flash word per
       * iteration, which is what `z = z + 4` over the byte buffer means. On
       * x86-64 (LP64) `unsigned long` is 8 bytes, so it steps 8 and every
       * field is written into twice its own space, four data bytes followed by
       * four untouched 0xFF:
       *
       *     noncehash  4B 3A E3 F3 FF FF FF FF 76 5E F3 4C FF FF FF FF ...
       *
       * Writers and readers were equally wrong, so any single field still
       * round-tripped - which is why setup appeared to succeed. But the field
       * OFFSETS are plain byte arithmetic on uintptr_t (`adr + EElen_noncehash`
       * and friends), so they did NOT double. The setter put the PIN hash 64
       * bytes into the sector while the getter read it from byte 32, halfway
       * through the nonce. Hence a correct PIN producing a public key that
       * matched what setup logged, yet never matching what was read back.
       *
       * Stepping a uint32_t* restores the hardware's stride exactly; the reads
       * are already 32-bit-safe, since >>24/>>16/>>8 discard the high word.
       */
      ['void okcore_flashget_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n' +
       '\tfor (int z = 0; z <= len - 4; z = z + 4)',
       'void okcore_flashget_common(uint8_t *ptr, unsigned long *okemu_adr, int len)\n{\n' +
       '\tuint32_t *adr = (uint32_t *)okemu_adr;\n' +
       '\tfor (int z = 0; z <= len - 4; z = z + 4)'],
      ['void okcore_flashset_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n' +
       '\tfor (int z = 0; z <= len - 4; z = z + 4)',
       'void okcore_flashset_common(uint8_t *ptr, unsigned long *okemu_adr, int len)\n{\n' +
       '\tuint32_t *adr = (uint32_t *)okemu_adr;\n' +
       '\tfor (int z = 0; z <= len - 4; z = z + 4)'],

      /*
       * byteprint() is the firmware's debug hex dumper, and callers hand it
       * null freely - webcryptcheck() does `byteprint(_appid, 32)` on a path
       * where ctap_filter_invalid_credentials() passes no appid at all. On the
       * MK20DX256 that reads flash from address 0 and prints 32 bytes of vector
       * table; the output is meaningless either way and nothing consumes it.
       * Hosted it is a segfault, which killed the device mid-CTAP2 getAssertion
       * on the very first FIDO request.
       *
       * Printing nothing for a null pointer is the same non-result without the
       * crash. (Mapping page zero would reproduce hardware exactly, but needs
       * vm.mmap_min_addr=0 - see the OnlyKey.ino patch.)
       */
      ['void byteprint(uint8_t *bytes, int size)\n{\n#ifdef DEBUG\n\tSerial.println();',
       'void byteprint(uint8_t *bytes, int size)\n{\n#ifdef DEBUG\n\tif (!bytes) return;\n\tSerial.println();'],

      /*
       * factorydefault()'s DEBUG-only dump walks 64 KB from address 0. Page
       * zero is deliberately left unmapped here (see the OnlyKey.ino patch),
       * so it faults on the first read. Start at the first mapped flash page;
       * this is diagnostic output only and nothing depends on its contents.
       */
      ['\t\tuintptr_t adr = 0x0;\n\t\tfor (int i = 0; i < 65536; i += 4)',
       '\t\tuintptr_t adr = 0x1000;\n\t\tfor (int i = 0; i < 65536; i += 4)'],

      /*
       * ctap_flash() - the mode==2 (write resident key) branch is the only one
       * with no return. See MISSING_RETURNS above; this is the one that hung
       * every FIDO2 registration. Every other branch returns 0 on success.
       */
      ['\t\t//hidprint("Successfully set CTAP Value");\n\t}\n\t#endif\n}',
       '\t\t//hidprint("Successfully set CTAP Value");\n\t}\n\t#endif\n\treturn 0;\n}'],
    ],
  },
  {
    /*
     * ctap_atomic_count() - the amount != 0 branches set the counter and then
     * fall off the end. Returning the stored value is what the amount == 0
     * branch does; re-reading it keeps the two consistent. See MISSING_RETURNS.
     */
    file: 'libraries/fido2/device.cpp',
    edits: [
      ['    } else {\n        setCounter(amount+counter1);\n    }\n}',
       '    } else {\n        setCounter(amount+counter1);\n    }\n    return getCounter();\n}'],
    ],
  },
  {
    /*
     * send_stored_response() - the whole body is inside
     * `if (profilemode != NONENCRYPTEDPROFILE)`, so a non-encrypted profile
     * falls off the end. ret is still 0 there, which is what the inner return
     * would have produced. See MISSING_RETURNS.
     */
    file: 'libraries/fido2/ok_extension.cpp',
    edits: [
      ['\t\treturn ret; \n\t}\n}',
       '\t\treturn ret; \n\t}\n\treturn ret;\n}'],
    ],
  },
  {
    /*
     * `okeeprom_eeset_*(0)` passes a null POINTER, not a value: the setters
     * take `uint8_t *ptr` and okeeprom_eeset_common() does `*ptr++`. The
     * author meant "store 0", and on the MK20DX256 that is exactly what
     * happens - address 0 is the start of flash, whose first word is the
     * vector table's initial stack pointer (_estack = 0x20008000). Read
     * little-endian, byte 0 is 0x00, so the write stores zero and the
     * firmware is correct by coincidence.
     *
     * Hosted, page zero is unmapped and the same read is a segfault. It fired
     * on OnlyKey.ino:700, in the branch taken when a CORRECT PIN has just been
     * entered - so the device rebooted at the moment of a successful unlock and
     * never reached `unlocked = true`, which looked exactly like a rejected PIN.
     *
     * Storing a real zero byte reproduces the hardware result without relying
     * on page zero being mapped. (Mapping it would need vm.mmap_min_addr=0,
     * which would remove NULL-dereference protection machine-wide; 4096 is
     * enough for everything else the firmware reaches.)
     */
    file: 'sketch/OnlyKey.ino',
    edits: [
      ['okeeprom_eeset_sincelastregularlogin (0);',
       '{ uint8_t okemu_zero = 0; okeeprom_eeset_sincelastregularlogin(&okemu_zero); }'],
      ['okeeprom_eeset_failedlogins(0);',
       '{ uint8_t okemu_zero = 0; okeeprom_eeset_failedlogins(&okemu_zero); }'],
      ['okeeprom_eeset_sincelastregularlogin(0);',
       '{ uint8_t okemu_zero = 0; okeeprom_eeset_sincelastregularlogin(&okemu_zero); }'],
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
