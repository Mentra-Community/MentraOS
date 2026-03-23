/*
 * Copyright (c) 2024 Nordic Semiconductor
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 *
 */
/* The include guards used here ensures that a different Mbed TLS config is not
 * added to the build and used by accident. Hence, this guard is not
 * equivalent to naming of this file.
 */
#ifndef MBEDTLS_CONFIG_FILE_H
#define MBEDTLS_CONFIG_FILE_H

/* This file includes configurations for Mbed TLS for platform and TLS/DTLS and X.509
 * and it should be used inside TF-M build and when CONFIG_MBEDTLS_LEGACY_CRYPTO_C is
 * not used
 */

/* TF-M */
/* #undef MBEDTLS_PSA_CRYPTO_SPM */

/* PSA core configurations */
#define MBEDTLS_PSA_CRYPTO_CLIENT
/* #undef MBEDTLS_PSA_CRYPTO_C */
#define MBEDTLS_USE_PSA_CRYPTO
/* #undef MBEDTLS_PSA_CRYPTO_BUILTIN_KEYS */
/* Avoid redefinition as TF-M defines this on the command line */
#ifndef MBEDTLS_PSA_CRYPTO_KEY_ID_ENCODES_OWNER
/* #undef MBEDTLS_PSA_CRYPTO_KEY_ID_ENCODES_OWNER */
#endif

/* Platform */
#define MBEDTLS_PLATFORM_C
#define MBEDTLS_PLATFORM_MEMORY
#define MBEDTLS_NO_PLATFORM_ENTROPY
#define MBEDTLS_MEMORY_BUFFER_ALLOC_C
/* #undef MBEDTLS_DEBUG_C */
#define MBEDTLS_PSA_CRYPTO_EXTERNAL_RNG

/* Platform configurations for _ALT defines */
/* #undef MBEDTLS_PLATFORM_EXIT_ALT */
/* #undef MBEDTLS_PLATFORM_FPRINTF_ALT */
/* #undef MBEDTLS_PLATFORM_PRINTF_ALT */
/* #undef MBEDTLS_PLATFORM_SNPRINTF_ALT */
/* #undef MBEDTLS_PLATFORM_SETUP_TEARDOWN_ALT */
#define MBEDTLS_ENTROPY_HARDWARE_ALT

/* Threading configurations */
/* #undef MBEDTLS_THREADING_C */
/* #undef MBEDTLS_THREADING_ALT */

/* Legacy configurations for _ALT defines */
#define MBEDTLS_AES_SETKEY_ENC_ALT
#define MBEDTLS_AES_SETKEY_DEC_ALT
#define MBEDTLS_AES_ENCRYPT_ALT
#define MBEDTLS_AES_DECRYPT_ALT
/* #undef MBEDTLS_AES_ALT */
/* #undef MBEDTLS_CMAC_ALT */
/* #undef MBEDTLS_CCM_ALT */
/* #undef MBEDTLS_GCM_ALT */
#define MBEDTLS_CHACHA20_ALT
#define MBEDTLS_POLY1305_ALT
/* #undef MBEDTLS_CHACHAPOLY_ALT */
/* #undef MBEDTLS_DHM_ALT */
/* #undef MBEDTLS_ECP_ALT */
#define MBEDTLS_ECDH_GEN_PUBLIC_ALT
#define MBEDTLS_ECDH_COMPUTE_SHARED_ALT
#define MBEDTLS_ECDSA_GENKEY_ALT
#define MBEDTLS_ECDSA_SIGN_ALT
#define MBEDTLS_ECDSA_VERIFY_ALT
#define MBEDTLS_ECJPAKE_ALT
/* #undef MBEDTLS_RSA_ALT */
#define MBEDTLS_SHA1_ALT
#define MBEDTLS_SHA224_ALT
#define MBEDTLS_SHA256_ALT
/* #undef MBEDTLS_SHA384_ALT */
/* #undef MBEDTLS_SHA512_ALT */

/* Legacy configuration for RNG */
#define MBEDTLS_ENTROPY_FORCE_SHA256
#define MBEDTLS_ENTROPY_MAX_SOURCES                        1
#define MBEDTLS_NO_PLATFORM_ENTROPY

/* Nordic defines for library support. Note that these configurations are used by the PSA interface */
/* #undef MBEDTLS_LEGACY_CRYPTO_C */
/* #undef MBEDTLS_TLS_LIBRARY */
/* #undef MBEDTLS_X509_LIBRARY */

/* Platform configurations for Mbed TLS APIs*/
#define MBEDTLS_BASE64_C
#define MBEDTLS_OID_C
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_ASN1_WRITE_C

/* Ensure these are not enabled internal in NS build */
#if !defined(MBEDTLS_PSA_CRYPTO_SPM) && !defined(INSIDE_TFM_BUILD)

/* Legacy configurations for Mbed TLS APIs */
/* #undef MBEDTLS_CIPHER_C */
/* #undef MBEDTLS_MD_C */
/* #undef MBEDTLS_PK_C */
/* #undef MBEDTLS_PK_WRITE_C */
/* #undef MBEDTLS_PK_PARSE_C */
/* #undef MBEDTLS_PEM_PARSE_C */
/* #undef MBEDTLS_PEM_WRITE_C */

/* TLS/DTLS configurations */
/* #undef MBEDTLS_SSL_ALL_ALERT_MESSAGES */
/* #undef MBEDTLS_SSL_DTLS_CONNECTION_ID */
/* #undef MBEDTLS_SSL_CONTEXT_SERIALIZATION */
/* #undef MBEDTLS_SSL_DEBUG_ALL */
/* #undef MBEDTLS_SSL_ENCRYPT_THEN_MAC */
/* #undef MBEDTLS_SSL_EXTENDED_MASTER_SECRET */
/* #undef MBEDTLS_SSL_KEEP_PEER_CERTIFICATE */
/* #undef MBEDTLS_SSL_RENEGOTIATION */
/* #undef MBEDTLS_SSL_MAX_FRAGMENT_LENGTH */
/* #undef MBEDTLS_SSL_PROTO_TLS1_2 */
/* #undef MBEDTLS_SSL_PROTO_TLS1_3 */
/* #undef MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_PSK_ENABLED */
/* #undef MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_EPHEMERAL_ENABLED */
/* #undef MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_PSK_EPHEMERAL_ENABLED */
/* #undef MBEDTLS_SSL_TLS1_3_COMPATIBILITY_MODE */
/* #undef MBEDTLS_SSL_PROTO_DTLS */
/* #undef MBEDTLS_SSL_ALPN */
/* #undef MBEDTLS_SSL_DTLS_ANTI_REPLAY */
/* #undef MBEDTLS_SSL_DTLS_HELLO_VERIFY */
/* #undef MBEDTLS_SSL_DTLS_SRTP */
/* #undef MBEDTLS_SSL_DTLS_CLIENT_PORT_REUSE */
/* #undef MBEDTLS_SSL_SESSION_TICKETS */
#ifndef MBEDTLS_SSL_EXPORT_KEYS
/* #undef MBEDTLS_SSL_EXPORT_KEYS */
#endif
/* #undef MBEDTLS_SSL_SERVER_NAME_INDICATION */
/* #undef MBEDTLS_SSL_VARIABLE_BUFFER_LENGTH */
/* #undef MBEDTLS_SSL_CACHE_C */
/* #undef MBEDTLS_SSL_TICKET_C */
/* #undef MBEDTLS_SSL_CLI_C */
/* #undef MBEDTLS_SSL_COOKIE_C */
/* #undef MBEDTLS_SSL_SRV_C */
/* #undef MBEDTLS_SSL_TLS_C */
/* #undef MBEDTLS_SSL_IN_CONTENT_LEN */
/* #undef MBEDTLS_SSL_OUT_CONTENT_LEN */
/* #undef MBEDTLS_SSL_CIPHERSUITES */

/* #undef MBEDTLS_X509_RSASSA_PSS_SUPPORT */
/* #undef MBEDTLS_X509_USE_C */
/* #undef MBEDTLS_X509_CRT_PARSE_C */
/* #undef MBEDTLS_X509_CRL_PARSE_C */
/* #undef MBEDTLS_X509_CSR_PARSE_C */
/* #undef MBEDTLS_X509_CREATE_C */
/* #undef MBEDTLS_X509_CRT_WRITE_C */
/* #undef MBEDTLS_X509_CSR_WRITE_C */
/* #undef MBEDTLS_X509_REMOVE_INFO */

/* #undef MBEDTLS_KEY_EXCHANGE_PSK_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_DHE_PSK_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_ECDHE_PSK_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_RSA_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_RSA_PSK_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_DHE_RSA_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_ECDHE_RSA_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_ECDHE_ECDSA_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_ECDH_ECDSA_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_ECDH_RSA_ENABLED */
/* #undef MBEDTLS_KEY_EXCHANGE_ECJPAKE_ENABLED */

#endif /* !defined(MBEDTLS_PSA_CRYPTO_SPM) && !defined(INSIDE_TFM_BUILD) */

#define MBEDTLS_PSA_CRYPTO_CONFIG

/* Controlling some MPI sizes */
#define MBEDTLS_MPI_WINDOW_SIZE       6 /**< Maximum window size used. */
#define MBEDTLS_MPI_MAX_SIZE          256 /**< Maximum number of bytes for usable MPIs. */

#if CONFIG_MBEDTLS_CMAC_ALT
/* NCSDK-24838 */
#define MBEDTLS_CIPHER_MODE_CBC
#endif

/* KRKNWK-20181 */
/* #undef MBEDTLS_SSL_CLI_ALLOW_WEAK_CERTIFICATE_VERIFICATION_WITHOUT_HOSTNAME */

#endif /* MBEDTLS_CONFIG_FILE_H */
