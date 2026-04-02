/*
 * Copyright (c) 2022-2024, Arm Limited. All rights reserved.
 * Copyright (c) 2023-2024 Cypress Semiconductor Corporation (an Infineon
 * company) or an affiliate of Cypress Semiconductor Corporation. All rights
 * reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __CONFIG_BASE_H__
#define __CONFIG_BASE_H__

/* Platform Partition Configs */

/* Size of input buffer in platform service */
#ifndef PLATFORM_SERVICE_INPUT_BUFFER_SIZE
#define PLATFORM_SERVICE_INPUT_BUFFER_SIZE     64
#endif

/* Size of output buffer in platform service */
#ifndef PLATFORM_SERVICE_OUTPUT_BUFFER_SIZE
#define PLATFORM_SERVICE_OUTPUT_BUFFER_SIZE    64
#endif

/* The stack size of the Platform Secure Partition */
#ifndef PLATFORM_SP_STACK_SIZE
#define PLATFORM_SP_STACK_SIZE                 0x500
#endif

/* Disable Non-volatile counter module */
#ifndef PLATFORM_NV_COUNTER_MODULE_DISABLED
#define PLATFORM_NV_COUNTER_MODULE_DISABLED    0
#endif

/* Crypto Partition Configs */

/*
 * Heap size for the crypto backend
 * CRYPTO_ENGINE_BUF_SIZE needs to be >8KB for EC signing by attest module.
 */
#ifndef CRYPTO_ENGINE_BUF_SIZE
#define CRYPTO_ENGINE_BUF_SIZE                 0x2080
#endif

/* The max number of concurrent operations that can be active (allocated) at any time in Crypto */
#ifndef CRYPTO_CONC_OPER_NUM
#define CRYPTO_CONC_OPER_NUM                   8
#endif

/* Enable PSA Crypto random number generator module */
#ifndef CRYPTO_RNG_MODULE_ENABLED
#define CRYPTO_RNG_MODULE_ENABLED              1
#endif

/* Enable PSA Crypto Key module */
#ifndef CRYPTO_KEY_MODULE_ENABLED
#define CRYPTO_KEY_MODULE_ENABLED              1
#endif

/* Enable PSA Crypto AEAD module */
#ifndef CRYPTO_AEAD_MODULE_ENABLED
#define CRYPTO_AEAD_MODULE_ENABLED             1
#endif

/* Enable PSA Crypto MAC module */
#ifndef CRYPTO_MAC_MODULE_ENABLED
#define CRYPTO_MAC_MODULE_ENABLED              1
#endif

/* Enable PSA Crypto Hash module */
#ifndef CRYPTO_HASH_MODULE_ENABLED
#define CRYPTO_HASH_MODULE_ENABLED             1
#endif

/* Enable PSA Crypto Cipher module */
#ifndef CRYPTO_CIPHER_MODULE_ENABLED
#define CRYPTO_CIPHER_MODULE_ENABLED           1
#endif

/* Enable PSA Crypto asymmetric key signature module */
#ifndef CRYPTO_ASYM_SIGN_MODULE_ENABLED
#define CRYPTO_ASYM_SIGN_MODULE_ENABLED        1
#endif

/* Enable PSA Crypto asymmetric key encryption module */
#ifndef CRYPTO_ASYM_ENCRYPT_MODULE_ENABLED
#define CRYPTO_ASYM_ENCRYPT_MODULE_ENABLED     1
#endif

/* Enable PSA Crypto key derivation module */
#ifndef CRYPTO_KEY_DERIVATION_MODULE_ENABLED
#define CRYPTO_KEY_DERIVATION_MODULE_ENABLED   1
#endif

/* Default size of the internal scratch buffer used for PSA FF IOVec allocations */
#ifndef CRYPTO_IOVEC_BUFFER_SIZE
#define CRYPTO_IOVEC_BUFFER_SIZE               5120
#endif

/* Use stored NV seed to provide entropy */
#ifndef CRYPTO_NV_SEED
#define CRYPTO_NV_SEED                         1
#endif

/*
 * Only enable multi-part operations in Hash, MAC, AEAD and symmetric ciphers,
 * to optimize memory footprint in resource-constrained devices.
 */
#ifndef CRYPTO_SINGLE_PART_FUNCS_DISABLED
#define CRYPTO_SINGLE_PART_FUNCS_DISABLED      0
#endif

/*
 * The service assumes that the client interface and internal
 * interface towards the library that provides the PSA Crypto
 * core component maintain the same ABI. This is not the default
 * when using the Mbed TLS reference implementation
 */
#ifndef CRYPTO_LIBRARY_ABI_COMPAT
#define CRYPTO_LIBRARY_ABI_COMPAT (0)
#endif

/* The stack size of the Crypto Secure Partition */
#ifndef CRYPTO_STACK_SIZE
#define CRYPTO_STACK_SIZE                      0x1B00
#endif

/* FWU Partition Configs */

/* Size of the FWU internal data transfer buffer */
#ifndef TFM_FWU_BUF_SIZE
#define TFM_FWU_BUF_SIZE                       PSA_FWU_MAX_WRITE_SIZE
#endif

/* The stack size of the Firmware Update Secure Partition */
#ifndef FWU_STACK_SIZE
#define FWU_STACK_SIZE                         0x600
#endif

/* Attest Partition Configs */

/* Include optional claims in initial attestation token */
#ifndef ATTEST_INCLUDE_OPTIONAL_CLAIMS
#define ATTEST_INCLUDE_OPTIONAL_CLAIMS         1
#endif

/* Include COSE key-id in initial attestation token */
#ifndef ATTEST_INCLUDE_COSE_KEY_ID
#define ATTEST_INCLUDE_COSE_KEY_ID             0
#endif

/* The stack size of the Initial Attestation Secure Partition */
#ifndef ATTEST_STACK_SIZE
#define ATTEST_STACK_SIZE                      0x700
#endif

/* Set the initial attestation token profile */
#if (!ATTEST_TOKEN_PROFILE_PSA_IOT_1) && \
    (!ATTEST_TOKEN_PROFILE_PSA_2_0_0) && \
    (!ATTEST_TOKEN_PROFILE_ARM_CCA)
#define ATTEST_TOKEN_PROFILE_PSA_IOT_1         1
#endif

/* ITS Partition Configs */

/* Create flash FS if it doesn't exist for Internal Trusted Storage partition */
#ifndef ITS_CREATE_FLASH_LAYOUT
#define ITS_CREATE_FLASH_LAYOUT                1
#endif

/* Enable emulated RAM FS for platforms that don't have flash for Internal Trusted Storage partition */
#ifndef ITS_RAM_FS
#define ITS_RAM_FS                             0
#endif

/* Validate filesystem metadata every time it is read from flash */
#ifndef ITS_VALIDATE_METADATA_FROM_FLASH
#define ITS_VALIDATE_METADATA_FROM_FLASH       1
#endif

/* The maximum asset size to be stored in the Internal Trusted Storage */
#ifndef ITS_MAX_ASSET_SIZE
#define ITS_MAX_ASSET_SIZE                     512
#endif

/*
 * Size of the ITS internal data transfer buffer
 * (Default to the max asset size so that all requests can be handled in one iteration.)
 */
#ifndef ITS_BUF_SIZE
#define ITS_BUF_SIZE                           ITS_MAX_ASSET_SIZE
#endif

/* The maximum number of assets to be stored in the Internal Trusted Storage */
#ifndef ITS_NUM_ASSETS
#define ITS_NUM_ASSETS                         10
#endif

/* The stack size of the Internal Trusted Storage Secure Partition */
#ifndef ITS_STACK_SIZE
#define ITS_STACK_SIZE                         0x720
#endif

/* The size of the authentication tag used when authentication/encryption of ITS files is enabled */
#ifndef TFM_ITS_AUTH_TAG_LENGTH
#define TFM_ITS_AUTH_TAG_LENGTH                16
#endif

/* The size of the nonce used when ITS file encryption is enabled */
#ifndef TFM_ITS_ENC_NONCE_LENGTH
#define TFM_ITS_ENC_NONCE_LENGTH               12
#endif

/* PS Partition Configs */

/* Create flash FS if it doesn't exist for Protected Storage partition */
#ifndef PS_CREATE_FLASH_LAYOUT
#define PS_CREATE_FLASH_LAYOUT                 1
#endif

/* Enable emulated RAM FS for platforms that don't have flash for Protected Storage partition */
#ifndef PS_RAM_FS
#define PS_RAM_FS                              0
#endif

/* Enable rollback protection for Protected Storage partition */
#ifndef PS_ROLLBACK_PROTECTION
#define PS_ROLLBACK_PROTECTION                 1
#endif

/* Validate filesystem metadata every time it is read from flash */
#ifndef PS_VALIDATE_METADATA_FROM_FLASH
#define PS_VALIDATE_METADATA_FROM_FLASH        1
#endif

/* The maximum asset size to be stored in the Protected Storage */
#ifndef PS_MAX_ASSET_SIZE
#define PS_MAX_ASSET_SIZE                      2048
#endif

/* The maximum number of assets to be stored in the Protected Storage */
#ifndef PS_NUM_ASSETS
#define PS_NUM_ASSETS                          10
#endif

/* The stack size of the Protected Storage Secure Partition */
#ifndef PS_STACK_SIZE
#define PS_STACK_SIZE                          0x700
#endif

/* NS Agent Mailbox Partition Configs */

/* The stack size of the NS Agent Mailbox Secure Partition */
#ifndef NS_AGENT_MAILBOX_STACK_SIZE
#define NS_AGENT_MAILBOX_STACK_SIZE            0x800
#endif

/* SPM Configs */

#ifdef CONFIG_TFM_CONNECTION_POOL_ENABLE
/* The maximal number of secure services that are connected or requested at the same time */
#ifndef CONFIG_TFM_CONN_HANDLE_MAX_NUM
#define CONFIG_TFM_CONN_HANDLE_MAX_NUM          8
#endif
#endif

/* Disable the doorbell APIs */
#ifndef CONFIG_TFM_DOORBELL_API
#define CONFIG_TFM_DOORBELL_API                 0
#endif

/* Do not run the scheduler after handling a secure interrupt if the NSPE was pre-empted */
#ifndef CONFIG_TFM_SCHEDULE_WHEN_NS_INTERRUPTED
#define CONFIG_TFM_SCHEDULE_WHEN_NS_INTERRUPTED 0
#endif

/* Mask Non-Secure interrupts when executing in secure state. */
#ifndef CONFIG_TFM_SECURE_THREAD_MASK_NS_INTERRUPT
#define CONFIG_TFM_SECURE_THREAD_MASK_NS_INTERRUPT 0
#endif

/* Enable OTP/NV_COUNTERS emulation in RAM */
#ifndef OTP_NV_COUNTERS_RAM_EMULATION
#define OTP_NV_COUNTERS_RAM_EMULATION           0
#endif

#endif /* __CONFIG_BASE_H__ */
