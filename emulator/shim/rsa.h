/*
 * rsa.h - shadows mbedtls-2.4.0/rsa.h to bridge one 32-bit assumption.
 *
 * okcrypto.cpp's rsa_decrypt() holds its output length in an `unsigned int`
 * and passes &olen to mbedtls_rsa_rsaes_pkcs1_v15_decrypt(), which wants a
 * `size_t *`. On the MK20DX256 those are the same 32-bit type, so the firmware
 * is correct as written; on x86-64 size_t is 64-bit and the call is a type
 * error.
 *
 * Rather than edit okcrypto.cpp, we pull in the real header and add a C++
 * overload taking `unsigned int *`. Overload resolution picks it for exactly
 * the firmware's call, and it round-trips through a real size_t.
 *
 * This file is only reached because emulator/shim precedes the mbedtls
 * directory on the include path; #include_next then resolves to the genuine
 * header. The mbedtls sources themselves are untouched and still compile
 * against their own declaration.
 *
 * This stays a shim rather than an OK_EMULATOR gate in okcrypto.cpp because the
 * mismatch is a property of the vendored library's ABI on this host, not of the
 * firmware's logic - and adding the overload costs the device build nothing,
 * since it never sees this header.
 */
#ifndef OKEMU_RSA_SHIM_H
#define OKEMU_RSA_SHIM_H

#include_next "rsa.h"

/* Only needed where size_t is wider than unsigned int; on a 32-bit target the
 * two signatures would collide, so leave the real declaration alone there. */
#if defined(__cplusplus) && (__SIZEOF_SIZE_T__ > __SIZEOF_INT__)

/*
 * onlykey.h pulls okcrypto.h - and therefore this header - in from inside an
 * `extern "C"` block, where C linkage would forbid overloading. Force C++
 * linkage for the bridge so it can coexist with the real declaration.
 */
extern "C++" {

static inline int mbedtls_rsa_rsaes_pkcs1_v15_decrypt(
    mbedtls_rsa_context *ctx,
    int (*f_rng)(void *, unsigned char *, size_t),
    void *p_rng,
    int mode,
    unsigned int *olen,
    const unsigned char *input,
    unsigned char *output,
    size_t output_max_len) {
  size_t wide = olen ? (size_t)*olen : 0;
  int ret = mbedtls_rsa_rsaes_pkcs1_v15_decrypt(ctx, f_rng, p_rng, mode,
                                                &wide, input, output,
                                                output_max_len);
  if (olen) *olen = (unsigned int)wide;
  return ret;
}

}  // extern "C++"

#endif
#endif /* OKEMU_RSA_SHIM_H */
