/*
 * Copyright (c) 2023 Nordic Semiconductor ASA.
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 *
 */

#ifndef __TFM_CONFIG_H__
#define __TFM_CONFIG_H__

/* Platform Partition Configs */

/* Size of input buffer in platform service */
#define PLATFORM_SERVICE_INPUT_BUFFER_SIZE 64

/* Size of output buffer in platform service */
#define PLATFORM_SERVICE_OUTPUT_BUFFER_SIZE 64

/* The stack size of the Platform Secure Partition */
#define PLATFORM_SP_STACK_SIZE 0x500

/* Disable Non-volatile counter module */
#define PLATFORM_NV_COUNTER_MODULE_DISABLED 1

/* Crypto Partition Configs */

/*
 * Heap size for the crypto backend
 * CRYPTO_ENGINE_BUF_SIZE needs to be >8KB for EC signing by attest module.
 */
#define CRYPTO_ENGINE_BUF_SIZE 1

/* The max number of concurrent operations that can be active (allocated) at any time in Crypto */
#define CRYPTO_CONC_OPER_NUM 1

/* Enable PSA Crypto random number generator module */
#define CRYPTO_RNG_MODULE_ENABLED 1

/* Enable PSA Crypto Key module */
#define CRYPTO_KEY_MODULE_ENABLED 0

/* Enable PSA Crypto AEAD module */
#define CRYPTO_AEAD_MODULE_ENABLED 0

/* Enable PSA Crypto MAC module */
#define CRYPTO_MAC_MODULE_ENABLED 0

/* Enable PSA Crypto Hash module */
#define CRYPTO_HASH_MODULE_ENABLED 0

/* Enable PSA Crypto Cipher module */
#define CRYPTO_CIPHER_MODULE_ENABLED 0

/* Enable PSA Crypto PAKE module */
#define CRYPTO_PAKE_MODULE_ENABLED 0

/* Enable PSA Crypto asymmetric key signature module */
#define CRYPTO_ASYM_SIGN_MODULE_ENABLED 0

/* Enable PSA Crypto asymmetric key encryption module */
#define CRYPTO_ASYM_ENCRYPT_MODULE_ENABLED 0

/* Enable PSA Crypto key derivation module */
#define CRYPTO_KEY_DERIVATION_MODULE_ENABLED 0

/* Default size of the internal scratch buffer used for PSA FF IOVec allocations */
#define CRYPTO_IOVEC_BUFFER_SIZE 1024

/* Use stored NV seed to provide entropy */
#define CRYPTO_NV_SEED 0

/*
 * Only enable multi-part operations in Hash, MAC, AEAD and symmetric ciphers,
 * to optimize memory footprint in resource-constrained devices.
 */
#define CRYPTO_SINGLE_PART_FUNCS_DISABLED 0

/* The stack size of the Crypto Secure Partition */
#define CRYPTO_STACK_SIZE 0x800

/* ABI compatibility between client and crypto service */
#define CRYPTO_LIBRARY_ABI_COMPAT 1

/* FWU Partition Configs */

/* Size of the FWU internal data transfer buffer */
/* #undef TFM_FWU_BUF_SIZE */

/* The stack size of the Firmware Update Secure Partition */
/* #undef FWU_STACK_SIZE */

/* Attest Partition Configs */

/* Include optional claims in initial attestation token */
#define ATTEST_INCLUDE_OPTIONAL_CLAIMS 0

/* Include COSE key-id in initial attestation token */
#define ATTEST_INCLUDE_COSE_KEY_ID 0

/* The stack size of the Initial Attestation Secure Partition */
/* #undef ATTEST_STACK_SIZE */

/* Set the initial attestation token profile */
/* The TF-M config_base.h configuration will do
 * #define ATTEST_TOKEN_PROFILE_PSA_IOT_1 1, if non of the token profiles are
 * chosen. While #define will define it with value 0 if the variables are 0
 * not set. This causes a redefine warning, so ignoring the token profile if
 * initial attestation is not enabled */
#ifdef TFM_PARTITION_INITIAL_ATTESTATION
#define ATTEST_TOKEN_PROFILE_PSA_IOT_1 0
#define ATTEST_TOKEN_PROFILE_PSA_2_0_0 0
#define ATTEST_TOKEN_PROFILE_ARM_CCA 0
#endif

/* ITS Partition Configs */

/* Create flash FS if it doesn't exist for Internal Trusted Storage partition */
#define ITS_CREATE_FLASH_LAYOUT 0

/* Enable emulated RAM FS for platforms that don't have flash for Internal Trusted Storage partition */
#define ITS_RAM_FS 0

/* Validate filesystem metadata every time it is read from flash */
#define ITS_VALIDATE_METADATA_FROM_FLASH 0

/* The maximum asset size to be stored in the Internal Trusted Storage */
/* #undef ITS_MAX_ASSET_SIZE */

/*
 * Size of the ITS internal data transfer buffer
 * (Default to the max asset size so that all requests can be handled in one iteration.)
 */
/* #undef ITS_BUF_SIZE */

/* The maximum number of assets to be stored in the Internal Trusted Storage */
/* #undef ITS_NUM_ASSETS */

/* The stack size of the Internal Trusted Storage Secure Partition */
/* #undef ITS_STACK_SIZE */

/* PS Partition Configs */

/* Create flash FS if it doesn't exist for Protected Storage partition */
#define PS_CREATE_FLASH_LAYOUT 0

/* Enable emulated RAM FS for platforms that don't have flash for Protected Storage partition */
#define PS_RAM_FS 0

/* Enable rollback protection for Protected Storage partition */
#define PS_ROLLBACK_PROTECTION 0

/* Validate filesystem metadata every time it is read from flash */
#define PS_VALIDATE_METADATA_FROM_FLASH 0

/* The maximum asset size to be stored in the Protected Storage */
/* #undef PS_MAX_ASSET_SIZE */

/* The maximum number of assets to be stored in the Protected Storage */
/* #undef PS_NUM_ASSETS */

/* The stack size of the Protected Storage Secure Partition */
/* #undef PS_STACK_SIZE */

/* Enable/Disable the doorbell APIs */
#define CONFIG_TFM_DOORBELL_API 0

#endif /* __TFM_CONFIG_H__ */
