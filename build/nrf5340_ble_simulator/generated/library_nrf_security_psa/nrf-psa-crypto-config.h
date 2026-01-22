/*
 * Copyright (c) 2024 Nordic Semiconductor
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 *
 */

#ifndef PSA_CRYPTO_CONFIG_H
#define PSA_CRYPTO_CONFIG_H

/*
 * All PSA_WANT_ symbols in alphabetical order
 */
#define PSA_WANT_AES_KEY_SIZE_128                          1
#define PSA_WANT_AES_KEY_SIZE_192                          1
#define PSA_WANT_AES_KEY_SIZE_256                          1
/* #undef PSA_WANT_ALG_CBC_NO_PADDING */
/* #undef PSA_WANT_ALG_CBC_PKCS7 */
/* #undef PSA_WANT_ALG_CCM */
/* #undef PSA_WANT_ALG_CCM_STAR_NO_TAG */
/* #undef PSA_WANT_ALG_CHACHA20_POLY1305 */
#define PSA_WANT_ALG_CMAC                                  1
/* #undef PSA_WANT_ALG_CTR */
#define PSA_WANT_ALG_CTR_DRBG                              1
/* #undef PSA_WANT_ALG_DETERMINISTIC_ECDSA */
#define PSA_WANT_ALG_ECB_NO_PADDING                        1
#define PSA_WANT_ALG_ECDH                                  1
/* #undef PSA_WANT_ALG_ECDSA */
/* #undef PSA_WANT_ALG_ECDSA_ANY */
/* #undef PSA_WANT_ALG_ED25519PH */
/* #undef PSA_WANT_ALG_ED448PH */
/* #undef PSA_WANT_ALG_GCM */
/* #undef PSA_WANT_ALG_HKDF */
/* #undef PSA_WANT_ALG_HKDF_EXPAND */
/* #undef PSA_WANT_ALG_HKDF_EXTRACT */
#define PSA_WANT_ALG_HMAC                                  1
/* #undef PSA_WANT_ALG_HMAC_DRBG */
/* #undef PSA_WANT_ALG_JPAKE */
/* #undef PSA_WANT_ALG_MD5 */
/* #undef PSA_WANT_ALG_PBKDF2_AES_CMAC_PRF_128 */
/* #undef PSA_WANT_ALG_PBKDF2_HMAC */
/* #undef PSA_WANT_ALG_PURE_EDDSA */
/* #undef PSA_WANT_ALG_RSA_OAEP */
/* #undef PSA_WANT_ALG_RSA_PKCS1V15_CRYPT */
/* #undef PSA_WANT_ALG_RSA_PKCS1V15_SIGN */
/* #undef PSA_WANT_ALG_RSA_PKCS1V15_SIGN_RAW */
/* #undef PSA_WANT_ALG_RSA_PSS */
/* #undef PSA_WANT_ALG_RSA_PSS_ANY_SALT */
/* #undef PSA_WANT_ALG_SHA3_224 */
/* #undef PSA_WANT_ALG_SHA3_256 */
/* #undef PSA_WANT_ALG_SHA3_384 */
/* #undef PSA_WANT_ALG_SHA3_512 */
/* #undef PSA_WANT_ALG_SHA_1 */
#define PSA_WANT_ALG_SHA_224                               1
#define PSA_WANT_ALG_SHA_256                               1
/* #undef PSA_WANT_ALG_SHA_384 */
/* #undef PSA_WANT_ALG_SHA_512 */
/* #undef PSA_WANT_ALG_SHA_512_224 */
/* #undef PSA_WANT_ALG_SHA_512_256 */
/* #undef PSA_WANT_ALG_SPAKE2P_CMAC */
/* #undef PSA_WANT_ALG_SPAKE2P_HMAC */
/* #undef PSA_WANT_ALG_SPAKE2P_MATTER */
/* #undef PSA_WANT_ALG_SRP_6 */
/* #undef PSA_WANT_ALG_SRP_PASSWORD_HASH */
/* #undef PSA_WANT_ALG_STREAM_CIPHER */
/* #undef PSA_WANT_ALG_TLS12_ECJPAKE_TO_PMS */
/* #undef PSA_WANT_ALG_TLS12_PRF */
/* #undef PSA_WANT_ALG_TLS12_PSK_TO_MS */
/* #undef PSA_WANT_ALG_XTS */
/* #undef PSA_WANT_ECC_BRAINPOOL_P_R1_160 */
/* #undef PSA_WANT_ECC_BRAINPOOL_P_R1_192 */
/* #undef PSA_WANT_ECC_BRAINPOOL_P_R1_224 */
/* #undef PSA_WANT_ECC_BRAINPOOL_P_R1_256 */
/* #undef PSA_WANT_ECC_BRAINPOOL_P_R1_320 */
/* #undef PSA_WANT_ECC_BRAINPOOL_P_R1_384 */
/* #undef PSA_WANT_ECC_BRAINPOOL_P_R1_512 */
/* #undef PSA_WANT_ECC_FRP_V1_256 */
/* #undef PSA_WANT_ECC_MONTGOMERY_255 */
/* #undef PSA_WANT_ECC_MONTGOMERY_448 */
/* #undef PSA_WANT_ECC_SECP_K1_192 */
/* #undef PSA_WANT_ECC_SECP_K1_224 */
/* #undef PSA_WANT_ECC_SECP_K1_256 */
/* #undef PSA_WANT_ECC_SECP_R1_192 */
/* #undef PSA_WANT_ECC_SECP_R1_224 */
#define PSA_WANT_ECC_SECP_R1_256                           1
/* #undef PSA_WANT_ECC_SECP_R1_384 */
/* #undef PSA_WANT_ECC_SECP_R1_521 */
/* #undef PSA_WANT_ECC_SECP_R2_160 */
/* #undef PSA_WANT_ECC_SECT_K1_163 */
/* #undef PSA_WANT_ECC_SECT_K1_233 */
/* #undef PSA_WANT_ECC_SECT_K1_239 */
/* #undef PSA_WANT_ECC_SECT_K1_283 */
/* #undef PSA_WANT_ECC_SECT_K1_409 */
/* #undef PSA_WANT_ECC_SECT_K1_571 */
/* #undef PSA_WANT_ECC_SECT_R1_163 */
/* #undef PSA_WANT_ECC_SECT_R1_233 */
/* #undef PSA_WANT_ECC_SECT_R1_283 */
/* #undef PSA_WANT_ECC_SECT_R1_409 */
/* #undef PSA_WANT_ECC_SECT_R1_571 */
/* #undef PSA_WANT_ECC_SECT_R2_163 */
/* #undef PSA_WANT_ECC_TWISTED_EDWARDS_255 */
/* #undef PSA_WANT_ECC_TWISTED_EDWARDS_448 */
#define PSA_WANT_GENERATE_RANDOM                           1
#define PSA_WANT_KEY_TYPE_AES                              1
/* #undef PSA_WANT_KEY_TYPE_CHACHA20 */
/* #undef PSA_WANT_KEY_TYPE_DERIVE */
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_BASIC               1
/* #undef PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_DERIVE */
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_EXPORT              1
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_GENERATE            1
#define PSA_WANT_KEY_TYPE_ECC_KEY_PAIR_IMPORT              1
#define PSA_WANT_KEY_TYPE_ECC_PUBLIC_KEY                   1
#define PSA_WANT_KEY_TYPE_HMAC                             1
/* #undef PSA_WANT_KEY_TYPE_PASSWORD */
/* #undef PSA_WANT_KEY_TYPE_PASSWORD_HASH */
/* #undef PSA_WANT_KEY_TYPE_PEPPER */
/* #undef PSA_WANT_KEY_TYPE_RAW_DATA */
/* #undef PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_BASIC */
/* #undef PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_DERIVE */
/* #undef PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_EXPORT */
/* #undef PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_GENERATE */
/* #undef PSA_WANT_KEY_TYPE_RSA_KEY_PAIR_IMPORT */
/* #undef PSA_WANT_KEY_TYPE_RSA_PUBLIC_KEY */
/* #undef PSA_WANT_KEY_TYPE_SPAKE2P_KEY_PAIR_BASIC */
/* #undef PSA_WANT_KEY_TYPE_SPAKE2P_KEY_PAIR_DERIVE */
/* #undef PSA_WANT_KEY_TYPE_SPAKE2P_KEY_PAIR_EXPORT */
/* #undef PSA_WANT_KEY_TYPE_SPAKE2P_KEY_PAIR_GENERATE */
/* #undef PSA_WANT_KEY_TYPE_SPAKE2P_KEY_PAIR_IMPORT */
/* #undef PSA_WANT_KEY_TYPE_SPAKE2P_PUBLIC_KEY */
/* #undef PSA_WANT_KEY_TYPE_SRP_KEY_PAIR_BASIC */
/* #undef PSA_WANT_KEY_TYPE_SRP_KEY_PAIR_DERIVE */
/* #undef PSA_WANT_KEY_TYPE_SRP_KEY_PAIR_EXPORT */
/* #undef PSA_WANT_KEY_TYPE_SRP_KEY_PAIR_IMPORT */
/* #undef PSA_WANT_KEY_TYPE_SRP_PUBLIC_KEY */
/* #undef PSA_WANT_RSA_KEY_SIZE_1024 */
/* #undef PSA_WANT_RSA_KEY_SIZE_1536 */
/* #undef PSA_WANT_RSA_KEY_SIZE_2048 */
/* #undef PSA_WANT_RSA_KEY_SIZE_3072 */
/* #undef PSA_WANT_RSA_KEY_SIZE_4096 */
/* #undef PSA_WANT_RSA_KEY_SIZE_6144 */
/* #undef PSA_WANT_RSA_KEY_SIZE_8192 */
/* #undef PSA_WANT_ALG_SP800_108_COUNTER_CMAC */
/* #undef PSA_WANT_ALG_SP800_108_COUNTER_HMAC */

/* The Adjusting is done in this file */
#define PSA_CRYPTO_ADJUST_KEYPAIR_TYPES_H

#endif /* PSA_CRYPTO_CONFIG_H */
