/*
 * Copyright (c) 2021-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLAT_OTP_H__
#define __TFM_PLAT_OTP_H__

#include <stdint.h>
#include <stddef.h>
#include "tfm_plat_defs.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifdef PLATFORM_DEFAULT_OTP
enum tfm_otp_element_id_t {
    PLAT_OTP_ID_HUK = 0,
    PLAT_OTP_ID_GUK,
    PLAT_OTP_ID_IAK,
    PLAT_OTP_ID_IAK_LEN,
    PLAT_OTP_ID_IAK_TYPE,
    PLAT_OTP_ID_IAK_ID,

    PLAT_OTP_ID_BOOT_SEED,
    PLAT_OTP_ID_LCS,
    PLAT_OTP_ID_IMPLEMENTATION_ID,
    PLAT_OTP_ID_CERT_REF,
    PLAT_OTP_ID_VERIFICATION_SERVICE_URL,
    PLAT_OTP_ID_PROFILE_DEFINITION,

    /* BL2 ROTPK must be contiguous */
    PLAT_OTP_ID_BL2_ROTPK_0,
    PLAT_OTP_ID_BL2_ROTPK_1,
    PLAT_OTP_ID_BL2_ROTPK_2,
    PLAT_OTP_ID_BL2_ROTPK_3,

    /* BL2 NV counters must be contiguous */
    PLAT_OTP_ID_NV_COUNTER_BL2_0,
    PLAT_OTP_ID_NV_COUNTER_BL2_1,
    PLAT_OTP_ID_NV_COUNTER_BL2_2,
    PLAT_OTP_ID_NV_COUNTER_BL2_3,

    PLAT_OTP_ID_NV_COUNTER_NS_0,
    PLAT_OTP_ID_NV_COUNTER_NS_1,
    PLAT_OTP_ID_NV_COUNTER_NS_2,

    PLAT_OTP_ID_KEY_BL2_ENCRYPTION,
    PLAT_OTP_ID_BL1_2_IMAGE,
    PLAT_OTP_ID_BL1_2_IMAGE_HASH,
    PLAT_OTP_ID_BL2_IMAGE_HASH,
    PLAT_OTP_ID_BL1_ROTPK_0,

    PLAT_OTP_ID_NV_COUNTER_BL1_0,

    PLAT_OTP_ID_ENTROPY_SEED,

    PLAT_OTP_ID_SECURE_DEBUG_PK,

    PLAT_OTP_ID_MAX = UINT32_MAX,
};
#else
#include "platform_otp_ids.h"
#endif /* PLATFORM_DEFAULT_OTP */

/* These are separate from the tfm_security_lifecycle_t definitions because here
 * the possible transitions are encoded by using the property that OTP bits can
 * be changed from a 0 to a 1, but not from a 1 to a 0.
 *
 * For example:
 * If the device is in PLAT_OTP_LCS_SECURED, it can transition to
 * PLAT_OTP_LCS_DECOMMISSIONED by setting bit 3, but cannot transition back to
 * PLAT_OTP_LCS_PSA_ROT_PROVISIONING as that would require setting bit 2 to 0,
 * which cannot be done as per OTP semantics.
 *
 * NON_PSA_ROT_DEBUG and RECOVERABLE_PSA_ROT_DEBUG must be handled separately to
 * OTP memory as they are reversible transitions from SECURED, and OTP cannot
 * handle reversible transitions.
 */
enum plat_otp_lcs_t {
    PLAT_OTP_LCS_ASSEMBLY_AND_TEST    = 0x0,
    PLAT_OTP_LCS_PSA_ROT_PROVISIONING = 0x1,
    PLAT_OTP_LCS_SECURED              = 0x3,
    PLAT_OTP_LCS_DECOMMISSIONED       = 0x7,
    PLAT_OTP_LCS_UNKNOWN              = 0xF,
    PLAT_OTP_LCS_MAX                  = UINT32_MAX,
};

/**
 * \brief                               Initialises OTP storage.
 *
 * \return                              TFM_PLAT_ERR_SUCCESS if the
 *                                      initialization succeeds, otherwise
 *                                      TFM_PLAT_ERR_SYSTEM_ERR
 */
enum tfm_plat_err_t tfm_plat_otp_init(void);

/**
 * \brief                               Reads the given OTP element.
 *
 * \param[in]  id                       ID of the element to read.
 * \param[in]  out_len                  Size of the buffer to read the element
 *                                      into in bytes.
 * \param[out] out                      Buffer to read the element into.
 *
 * \note                                If the size of the internal OTP
 *                                      representation of the item is different
 *                                      to out_len, then the smaller of the two
 *                                      is the amount of bytes that must be
 *                                      read.
 *
 * \retval TFM_PLAT_ERR_SUCCESS         The element is read successfully.
 * \retval TFM_PLAT_ERR_UNSUPPORTED     The given element has not been
 *                                      instanciated in OTP memory by this
 *                                      particular platform.
 * \retval TFM_PLAT_ERR_SYSTEM_ERR      An unspecified error occurred.
 */
enum tfm_plat_err_t tfm_plat_otp_read(enum tfm_otp_element_id_t id,
                                      size_t out_len, uint8_t *out);

/**
 * \brief                               Writes the specified bytes to the given
 *                                      OTP element.
 *
 * \param[in]  id                       ID of the element to write.
 * \param[in]  in_len                   Size of the buffer to write to the
 *                                      element in bytes.
 * \param[in]  in                       Pointer to the buffer to write to the
 *                                      element.
 *
 * \note                                This function must implement the OTP
 *                                      writing semantics, where any bit
 *                                      currently set to 1 cannot be set to 0.
 *                                      If such a write is requested, the
 *                                      function should return an error code and
 *                                      not alter the contents of OTP memory.
 *
 * \note                                If the size of the internal OTP
 *                                      representation of the item is smaller
 *                                      than in_len, this function must return
 *                                      an error other than TFM_PLAT_ERR_SUCCESS
 *                                      and not write any OTP.
 *
 * \retval TFM_PLAT_ERR_SUCCESS         The OTP is written successfully
 * \retval TFM_PLAT_ERR_UNSUPPORTED     The element is not supported.
 * \retval TFM_PLAT_ERR_SYSTEM_ERR      An unspecified error occurred.
 */
enum tfm_plat_err_t tfm_plat_otp_write(enum tfm_otp_element_id_t id,
                                       size_t in_len, const uint8_t *in);

/**
 * \brief                               Returns the size of a given OTP element.
 *
 * \param[in]  id                       ID of the element.
 * \param[out] size                     Size of the element.
 *
 * \retval TFM_PLAT_ERR_SUCCESS         The size is returned successfully.
 * \retval TFM_PLAT_ERR_UNSUPPORTED     The element is not supported.
 * \retval TFM_PLAT_ERR_SYSTEM_ERR      An unspecified error occurred.
 */
enum tfm_plat_err_t tfm_plat_otp_get_size(enum tfm_otp_element_id_t id,
                                          size_t *size);

/**
 * \brief                               Enable a secure provisioning mode, if
 *                                      supported.
 *
 * \retval TFM_PLAT_ERR_SUCCESS         The mode was enabled successfully.
 * \retval TFM_PLAT_ERR_SYSTEM_ERR      An unspecified error occurred.
 */
enum tfm_plat_err_t tfm_plat_otp_secure_provisioning_start(void);

/**
 * \brief                               Disable the secure provisioning mode
 *                                      once provisioning has finished.
 *
 * \retval TFM_PLAT_ERR_SUCCESS         The mode was disabled successfully.
 * \retval TFM_PLAT_ERR_SYSTEM_ERR      An unspecified error occurred.
 */
enum tfm_plat_err_t tfm_plat_otp_secure_provisioning_finish(void);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PLAT_OTP_H__ */
