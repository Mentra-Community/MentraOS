/*
 * Copyright (c) 2019-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_ATTEST_HAL_H__
#define __TFM_ATTEST_HAL_H__

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * \brief Security lifecycle of the device
 */
enum tfm_security_lifecycle_t {
    TFM_SLC_UNKNOWN                   = 0x0000u,
    TFM_SLC_ASSEMBLY_AND_TEST         = 0x1000u,
    TFM_SLC_PSA_ROT_PROVISIONING      = 0x2000u,
    TFM_SLC_SECURED                   = 0x3000u,
    TFM_SLC_NON_PSA_ROT_DEBUG         = 0x4000u,
    TFM_SLC_RECOVERABLE_PSA_ROT_DEBUG = 0x5000u,
    TFM_SLC_DECOMMISSIONED            = 0x6000u,
    TFM_SLC_MAX_VALUE                 = UINT32_MAX,
};

/**
 * \def VERIFICATION_URL_MAX_SIZE
 *
 * \brief Maximum size of verification URL in bytes
 */
#define VERIFICATION_URL_MAX_SIZE (32u)

/**
 * \def PROFILE_DEFINITION_MAX_SIZE
 *
 * \brief Maximum size of profile definition in bytes
 */
#define PROFILE_DEFINITION_MAX_SIZE (32u)

/**
 * \def PLATFORM_CONFIG_MAX_SIZE
 *
 * \brief Maximum size of the the platform configuration data.
 */
#define PLATFORM_CONFIG_MAX_SIZE (32u)

/**
 * \def PLATFORM_HASH_ALGO_ID_MAX_SIZE
 *
 * \brief Maximum size of the platform hash algorithm identifier string.
 */
#define PLATFORM_HASH_ALGO_ID_MAX_SIZE (32u)

/**
 * \brief Retrieve the security lifecycle of the device
 *
 * Security lifecycle is a mandatory claim in the initial attestation token.
 *
 * \return According to \ref tfm_security_lifecycle_t
 */
enum tfm_security_lifecycle_t tfm_attest_hal_get_security_lifecycle(void);

/**
 * \brief Retrieve the verification service indicator for initial attestation.
 *
 * It is used by relying party to locate a validation service for the token.
 * It can be a text string that can be used to locate the service or can be a
 * URL specifying the address of the service.
 *
 * \param[in/out] size  As an input value it indicates the size of the caller
 *                      allocated buffer (in bytes) to store the verification
 *                      service indicator. At return its value is updated with
 *                      the exact size of the verification service URL.
 * \param[out]    buf   Pointer to the buffer to store the verification service
 *                      URL.
 *
 * \return  Returns error code specified in \ref tfm_plat_err_t
 */
enum tfm_plat_err_t
tfm_attest_hal_get_verification_service(uint32_t *size, uint8_t *buf);

/**
 * \brief Retrieve the name of the profile definition document for initial
 *        attestation.
 *
 *  This document describes the 'profile' of the initial attestation token,
 *  being a full description of the claims, their usage, verification and
 *  token signing.
 *
 * \param[in/out] size  As an input value it indicates the size of the caller
 *                      allocated buffer (in bytes) to store the profile
 *                      definition. At return its value is updated with the
 *                      exact size of the profile definition.
 * \param[out]    buf   Pointer to the buffer to store the profile definition.
 *
 * \return  Returns error code specified in \ref tfm_plat_err_t
 */
enum tfm_plat_err_t
tfm_attest_hal_get_profile_definition(uint32_t *size, uint8_t *buf);

/**
 * \brief Retrieve the platform configuration data.
 *
 * The Root Non-Volatile Storage(RNVS) is an on-chip non-volatile storage
 * resource like fuses or on-chip flash that stores CCA platform immutable
 * boot parameters.
 *
 * \param[in/out] size  As an input value it indicates the size of the caller
 *                      allocated buffer (in bytes) to store the platform
 *                      config. At return its value is updated with the
 *                      exact size of the platform configuration data.
 * \param[out]    buf   Pointer to the buffer to store the platform
 *                      configuration data.
 *
 * \return  Returns error code specified in \ref tfm_plat_err_t
 */
enum tfm_plat_err_t
tfm_attest_hal_get_platform_config(uint32_t *size, uint8_t *buf);


/**
 * \brief Retrieve the platform hash algorithm identifier.
 *
 * According to IANA hash algorithm registry:
 *   - https://www.iana.org/assignments/hash-function-text-names/hash-function-text-names.xml
 *
 * \param[in/out] size  As an input value it indicates the size of the caller
 *                      allocated buffer (in bytes) to store the platform
 *                      hash algo. At return its value is updated with the
 *                      exact size of the platform hahs algo string.
 * \param[out]    buf   Pointer to the buffer to store the platform
 *                      hash algo string.
 *
 * \return  Returns error code specified in \ref tfm_plat_err_t
 */
enum tfm_plat_err_t
tfm_attest_hal_get_platform_hash_algo(uint32_t *size, uint8_t *buf);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_ATTEST_HAL_H__ */
