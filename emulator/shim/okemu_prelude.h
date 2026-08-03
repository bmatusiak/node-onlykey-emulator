/*
 * okemu_prelude.h - force-included (-include) into every translation unit.
 *
 * The Teensy core (WProgram.h) declares `uint32_t random(void)` / `void
 * srandom(uint32_t)`, which collide with glibc's `long int random(void)` /
 * `void srandom(unsigned)`. On the real toolchain (arm-none-eabi + -nostdlib)
 * glibc's declarations are never seen, so the conflict cannot arise.
 *
 * We pull in the system headers FIRST, then rename the Teensy spellings. Doing
 * it here - rather than in a shim Arduino.h - guarantees the ordering holds in
 * every TU, including ones that include <stdlib.h> only indirectly and later.
 *
 * Shadowing here rather than editing WProgram.h keeps a name collision that is
 * purely an artifact of hosting - the device links against no libc at all - out
 * of the firmware sources. Divergences the FIRMWARE genuinely owns are gated in
 * the OnlyKey sources under OK_EMULATOR instead; see README.
 */
#ifndef OKEMU_PRELUDE_H
#define OKEMU_PRELUDE_H

#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

/* Teensy's random()/srandom() -> distinct names, away from glibc's. */
#define random  teensy_random
#define srandom teensy_srandom

/*
 * kinetis.h defines these as raw Cortex-M inline asm:
 *     #define __disable_irq() __asm__ volatile("CPSID i":::"memory");
 * `cpsid`/`cpsie` are not x86 instructions, so any caller fails at assembly
 * time (the preprocessor and compiler are happy - only `as` objects).
 *
 * Interrupt masking has no meaning here: the firmware runs on one ordinary
 * thread and every peripheral it guards against is backed by memory rather
 * than by an ISR. The HAL's own shared state carries its own mutex.
 *
 * These are a FALLBACK for any translation unit that reaches __disable_irq()
 * without pulling in kinetis.h. They cannot override the header itself: it
 * #defines the same names unconditionally and later, and the last definition
 * wins. Rewriting kinetis.h's own spelling is the only lever, which is why the
 * staged patch in scripts/stage.js exists and is the one that actually works.
 *
 * The compiler barrier is kept in both, since the firmware brackets flash and
 * USB buffer updates with these and relies on them not being reordered.
 */
#define __disable_irq() __asm__ volatile("" ::: "memory")
#define __enable_irq()  __asm__ volatile("" ::: "memory")

#endif /* OKEMU_PRELUDE_H */
