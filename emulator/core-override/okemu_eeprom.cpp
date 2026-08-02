/*
 * okemu_eeprom.cpp - host replacement for the teensy3 core's eeprom.c.
 *
 * On the MK20DX256 these calls drive the FlexRAM/FlexNVM controller. Here they
 * read and write a 2 KB file-backed array in the HAL, so the emulated device
 * keeps its PINs, counters and integrity hash across restarts (and can be
 * wiped by a factory reset).
 *
 * The Arduino EEPROM library and the firmware's avr-style helpers both land
 * here; okeeprom.c is the heaviest user.
 */
#include <stdint.h>
#include <string.h>
#include "ok_hal.h"

extern "C" {

uint8_t eeprom_read_byte(const uint8_t *addr) {
  return okemu_eeprom_read((uint32_t)(uintptr_t)addr);
}

void eeprom_write_byte(uint8_t *addr, uint8_t value) {
  okemu_eeprom_write((uint32_t)(uintptr_t)addr, value);
}

uint16_t eeprom_read_word(const uint16_t *addr) {
  uint32_t a = (uint32_t)(uintptr_t)addr;
  return (uint16_t)(okemu_eeprom_read(a) | (okemu_eeprom_read(a + 1) << 8));
}

void eeprom_write_word(uint16_t *addr, uint16_t value) {
  uint32_t a = (uint32_t)(uintptr_t)addr;
  okemu_eeprom_write(a,     (uint8_t)value);
  okemu_eeprom_write(a + 1, (uint8_t)(value >> 8));
}

uint32_t eeprom_read_dword(const uint32_t *addr) {
  uint32_t a = (uint32_t)(uintptr_t)addr, v = 0;
  for (int i = 0; i < 4; i++) v |= (uint32_t)okemu_eeprom_read(a + i) << (8 * i);
  return v;
}

void eeprom_write_dword(uint32_t *addr, uint32_t value) {
  uint32_t a = (uint32_t)(uintptr_t)addr;
  for (int i = 0; i < 4; i++) okemu_eeprom_write(a + i, (uint8_t)(value >> (8 * i)));
}

void eeprom_read_block(void *buf, const void *addr, uint32_t len) {
  uint32_t a = (uint32_t)(uintptr_t)addr;
  uint8_t *out = (uint8_t *)buf;
  for (uint32_t i = 0; i < len; i++) out[i] = okemu_eeprom_read(a + i);
}

void eeprom_write_block(const void *buf, void *addr, uint32_t len) {
  uint32_t a = (uint32_t)(uintptr_t)addr;
  const uint8_t *in = (const uint8_t *)buf;
  for (uint32_t i = 0; i < len; i++) okemu_eeprom_write(a + i, in[i]);
}

/* The core exposes these two as the "only write if changed" variants. */
void eeprom_update_byte(uint8_t *addr, uint8_t value) {
  eeprom_write_byte(addr, value);
}

void eeprom_update_block(const void *buf, void *addr, uint32_t len) {
  eeprom_write_block(buf, addr, len);
}

void eeprom_initialize(void) {}

int eeprom_is_ready(void) { return 1; }

}  // extern "C"
