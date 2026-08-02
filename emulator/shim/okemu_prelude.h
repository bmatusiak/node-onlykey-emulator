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
 * This keeps the upstream sources untouched, per EXPLAINER.md.
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
 * than by an ISR. The HAL's own shared state carries its own mutex. Predefine
 * them as no-ops so kinetis.h's #define is skipped.
 *
 * The compiler barrier is kept, since the firmware brackets flash and USB
 * buffer updates with these and relies on them not being reordered.
 */
#define __disable_irq() __asm__ volatile("" ::: "memory")
#define __enable_irq()  __asm__ volatile("" ::: "memory")

#endif /* OKEMU_PRELUDE_H */
