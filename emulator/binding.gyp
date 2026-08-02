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
      "OKEMU=1"
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
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"]
    }
  ]
}
