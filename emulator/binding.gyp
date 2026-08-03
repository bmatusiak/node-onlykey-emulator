{
  "includes": ["sources.gypi"],

  # Shared by both targets: the addon needs ok_hal.h, the firmware needs the
  # rest. Staged paths are produced by scripts/stage.js.
  "target_defaults": {
    "include_dirs": [
      # shim first: our Adafruit_NeoPixel.h and rsa.h must shadow the
      # upstream copies further down the path.
      "shim",
      "src",

      # OnlyKey's vendored libraries
      ".stage/libraries/onlykey",
      ".stage/libraries/onlykey/utility",
      ".stage/libraries/Crypto",
      ".stage/libraries/SoftTimer",
      ".stage/libraries/T3Mac",
      ".stage/libraries/base64",
      ".stage/libraries/password",
      ".stage/libraries/sha1",
      ".stage/libraries/sha256",
      ".stage/libraries/totp",
      ".stage/libraries/tweetnacl",
      ".stage/libraries/justhashtweetnacl",
      ".stage/libraries/uECC",
      ".stage/libraries/ykcore",
      ".stage/libraries/yksim",
      ".stage/libraries/randombytes",
      ".stage/libraries/fido2",
      ".stage/libraries/tinycbor",
      ".stage/libraries/mbedtls-2.4.0",
      ".stage/libraries/flashkinetis",

      # the sketch itself
      ".stage/sketch",

      # staged Teensy core (OnlyKey USB stack + our overrides overlaid)
      ".stage/core",

      # stock Arduino libraries the firmware uses
      "../onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/EEPROM",
      "../onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/Time",
      "../onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/ADC"
    ],

    # Same board configuration the real firmware is built with - see
    # arduino-1.6.5-r5/preferences.txt (board=teensy31, usb=rawhid,
    # speed=72 MHz, keys=en-us) and hardware/teensy/avr/boards.txt.
    "defines": [
      "__MK20DX256__",
      "TEENSYDUINO=127",
      "USB_RAWHID",
      "F_CPU=72000000",
      "ARDUINO=10605",
      "LAYOUT_US_ENGLISH",

      # The firmware sources carry a handful of host-build adaptations behind
      # #ifdef OK_EMULATOR. The device toolchain never defines it, so the ARM
      # build compiles the #else branch and is unaffected. See README's
      # "Running 32-bit firmware on a 64-bit host".
      "OK_EMULATOR=1"
    ]
  },

  "targets": [
    {
      # ------------------------------------------------------------------
      # The firmware, built as close to its native configuration as a host
      # compiler allows: gnu++11, the standard it was written against.
      # ------------------------------------------------------------------
      "target_name": "okemu_firmware",
      "type": "static_library",
      "sources": ["<@(okemu_sources)"],

      # make runs from build/, so the forced include needs an absolute path
      "cflags": [
        "-w", "-fpermissive", "-fPIC",
        "-include", "<(module_root_dir)/shim/okemu_prelude.h"
      ],
      "cflags_cc": [
        "-w", "-fpermissive", "-fPIC", "-std=gnu++11", "-fexceptions",
        "-include", "<(module_root_dir)/shim/okemu_prelude.h"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],

      # The firmware is 32-bit code: it stores pointers in unsigned long and
      # relies on wrapping arithmetic. Keep GCC from exploiting the resulting
      # UB, and stop strict aliasing from reordering the register and flash
      # accesses that the HAL backs with mmap'd memory.
      "conditions": [
        ["OS=='linux'", {
          "cflags+": ["-fno-strict-aliasing", "-fwrapv"],
          "cflags_cc+": ["-fno-strict-aliasing", "-fwrapv"]
        }]
      ]
    },
    {
      # ------------------------------------------------------------------
      # The N-API surface. node-addon-api requires C++17, which is why this
      # cannot share a compile line with the firmware above.
      # ------------------------------------------------------------------
      "target_name": "onlykey_emulator",
      "sources": ["src/addon.cpp"],
      "dependencies": ["okemu_firmware"],

      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=gnu++17", "-fexceptions"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],

      # -Bsymbolic: bind the firmware's internal calls to its OWN definitions.
      #
      # The firmware was written for a freestanding target where the only code
      # in the image is its own, so it uses names that collide with libc -
      # okcore.cpp defines `recvmsg`, the OnlyKey message pump. Built as a
      # shared object those symbols are exported with default visibility and
      # their call sites go through the PLT, so the dynamic linker resolves
      # them against the global scope - node and libc - first. glibc exports
      # recvmsg(2), so every `recvmsg(0)` in the firmware was calling the
      # SOCKET syscall instead: it failed silently, and the device accepted HID
      # packets while never once reading them.
      #
      # -Bsymbolic resolves defined symbols within this module and leaves
      # undefined ones (the N-API entry points, libc) alone.
      "ldflags": ["-Wl,-Bsymbolic", "-rdynamic"]
    }
  ]
}
