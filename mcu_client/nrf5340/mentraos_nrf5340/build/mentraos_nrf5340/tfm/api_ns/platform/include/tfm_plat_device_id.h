/*
 * Copyright (c) 2018-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLAT_DEVICE_ID_H__
#define __TFM_PLAT_DEVICE_ID_H__
/**
 * \file tfm_plat_device_id.h
 *
 * The interfaces defined in this file are meant to provide the following
 * attributes of the device:
 *  - Instance ID:       Unique identifier of the device.
 *  - Implementation ID: Original implementation signer of the attestation key.
 *  - Hardware version:  Identify the GDSII that went to fabrication.
 */

/**
 * \note The interfaces defined in this file must be implemented for each
 *       SoC.
 */

#include <stdint.h>
#include "tfm_plat_defs.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * \def INSTANCE_ID_MAX_SIZE
 *
 * \brief Maximum size of instance ID in bytes
 */
#define INSTANCE_ID_MAX_SIZE (33u)

/**
 * \def IMPLEMENTATION_ID_MAX_SIZE
 *
 * \brief Maximum size of implementation ID in bytes
 */
#define IMPLEMENTATION_ID_MAX_SIZE (32u)

/**
 * \def CERTIFICATION_REF_MAX_SIZE
 *
 * \brief Maximum size of hardware version in bytes
 *
 * Recommended to use the European Article Number format: EAN-13 + '-' + 5
 * https://www.ietf.org/archive/id/draft-tschofenig-rats-psa-token-09.html#name-certification-reference
 */
#define CERTIFICATION_REF_MAX_SIZE (19u)

/**
 * \brief Get the Implementation ID of the device.
 *
 * This mandatory claim represents the original implementation signer of the
 * attestation key and identifies the contract between the report and
 * verification. A verification service will use this claim to locate the
 * details of the verification process. The claim will be represented by a
 * custom EAT claim with a value consisting of a CBOR byte string. The size of
 * this string will normally be 32 bytes to accommodate a 256 bit hash.
 *
 * \param[in/out] size  As an input value it indicates the size of the caller
 *                      allocated buffer (in bytes) to store the implementation
 *                      ID. At return its value is updated with the exact size
 *                      of the implementation ID.
 * \param[out]    buf   Pointer to the buffer to store the implementation ID
 *
 * \return  Returns error code specified in \ref tfm_plat_err_t
 */
enum tfm_plat_err_t tfm_plat_get_implementation_id(uint32_t *size,
                                                   uint8_t  *buf);

/**
 * \brief Get the PSA certification reference of the device.
 *
 * This optional claim provides metadata linking the token to the GDSII that
 * went to fabrication for this instance. It is represented as CBOR text string.
 * It is recommended to use for identification the format of the European
 * Article Number: EAN-13+5.
 *
 * \param[in/out] size  As an input value it indicates the size of the caller
 *                      allocated buffer (in bytes) to store the certification
 *                      reference. At return its value is updated with the exact
 *                      size of the certification reference.
 * \param[out]    buf   Pointer to the buffer to store the certification
 *                      reference.
 *
 * \return  Returns error code specified in \ref tfm_plat_err_t
 */
enum tfm_plat_err_t tfm_plat_get_cert_ref(uint32_t *size, uint8_t *buf);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PLAT_DEVICE_ID_H__ */
