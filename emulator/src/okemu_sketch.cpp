/*
 * okemu_sketch.cpp - compiles OnlyKey.ino as an ordinary translation unit.
 *
 * The Arduino IDE does not compile a .ino directly: it concatenates the
 * sketch, inserts forward declarations for every function it defines, and
 * feeds the result to the compiler as C++. That implicit prototype pass is why
 * OnlyKey.ino can call checkKey() from a Task initialiser 200 lines above the
 * definition.
 *
 * We reproduce that step here - headers, then the prototypes the IDE would
 * have generated, then the sketch itself - so the sketch compiles verbatim.
 * Prototypes are taken from the definitions in OnlyKey.ino; if a signature
 * there changes, update the matching line below.
 */
#include <Arduino.h>

#include "SoftTimer.h"
#include "Task.h"
#include "onlykey.h"

/* --- prototypes the Arduino preprocessor would emit (OnlyKey.ino order) --- */
void setup();
void checkKey(Task *me);
void sendKey(Task *me);
void payload(int duration);
void gen_press(void);
void gen_hold(void);
void process_slot(int s);
void sendInitialized(Task *me);
void resetkeys();
void ctrl_alt_del();
void lock_ok_and_screen();
void fw_hash(unsigned char *hashptr);
void keymap_press(char key);
void exceeded_login_attempts();

#include "OnlyKey.ino"
