/*
 * Adafruit_NeoPixel.h - emulator stand-in.
 *
 * The real library bit-bangs WS2812 timing with cycle-counted ARM assembly,
 * which has no meaning on a host CPU. okcore.cpp only uses five calls
 * (begin/Color/setPixelColor/setBrightness/show), so we present the same
 * surface and forward the resulting colour to the HAL, where the addon
 * publishes it to the UI.
 *
 * This shadows onlykey/libraries/Adafruit_NeoPixel/Adafruit_NeoPixel.h because
 * emulator/shim is first on the include path - the upstream copy is untouched.
 */
#ifndef ADAFRUIT_NEOPIXEL_H
#define ADAFRUIT_NEOPIXEL_H

#include <stdint.h>
#include "ok_hal.h"

/* Colour order / bitstream-rate flags. Only kept so the firmware's
 * `NEO_GRB + NEO_KHZ800` constructor argument still compiles. */
#define NEO_RGB     0x06
#define NEO_GRB     0x52
#define NEO_BRG     0x58
#define NEO_KHZ800  0x0000
#define NEO_KHZ400  0x0100

typedef uint8_t neoPixelType;

class Adafruit_NeoPixel {
 public:
  Adafruit_NeoPixel(uint16_t n = 1, uint8_t pin = 6, neoPixelType t = NEO_GRB + NEO_KHZ800)
      : numLEDs(n > OKEMU_NUM_PIXELS ? OKEMU_NUM_PIXELS : n),
        pin_(pin), type_(t), brightness_(0) {
    for (int i = 0; i < OKEMU_NUM_PIXELS; i++) r_[i] = g_[i] = b_[i] = 0;
  }

  void begin(void) {}
  void end(void) {}

  static uint32_t Color(uint8_t r, uint8_t g, uint8_t b) {
    return ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
  }

  void setPixelColor(uint16_t n, uint32_t c) {
    if (n >= OKEMU_NUM_PIXELS) return;
    r_[n] = (uint8_t)(c >> 16);
    g_[n] = (uint8_t)(c >> 8);
    b_[n] = (uint8_t)c;
  }

  void setPixelColor(uint16_t n, uint8_t r, uint8_t g, uint8_t b) {
    setPixelColor(n, Color(r, g, b));
  }

  /*
   * Adafruit stores brightness as value+1 and scales with (v * b) >> 8.
   * We keep the same convention, and apply it at show() so the UI is handed
   * the colour actually visible on the device.
   */
  void setBrightness(uint8_t b) { brightness_ = b; }
  uint8_t getBrightness(void) const { return brightness_ ? brightness_ - 1 : 0; }

  uint16_t numPixels(void) const { return numLEDs; }

  void clear(void) {
    for (int i = 0; i < OKEMU_NUM_PIXELS; i++) r_[i] = g_[i] = b_[i] = 0;
  }

  void show(void) {
    const uint16_t scale = brightness_;  /* 0 => no scaling, as upstream */
    for (int i = 0; i < OKEMU_NUM_PIXELS; i++) {
      uint8_t r = r_[i], g = g_[i], b = b_[i];
      if (scale) {
        r = (uint8_t)((r * scale) >> 8);
        g = (uint8_t)((g * scale) >> 8);
        b = (uint8_t)((b * scale) >> 8);
      }
      okemu_led_set(i, r, g, b);
    }
    okemu_led_show();
  }

  uint32_t getPixelColor(uint16_t n) const {
    if (n >= OKEMU_NUM_PIXELS) return 0;
    return Color(r_[n], g_[n], b_[n]);
  }

 private:
  uint16_t numLEDs;
  uint8_t  pin_, type_, brightness_;
  uint8_t  r_[OKEMU_NUM_PIXELS], g_[OKEMU_NUM_PIXELS], b_[OKEMU_NUM_PIXELS];
};

#endif /* ADAFRUIT_NEOPIXEL_H */
