/*
 * Copyright (c) 2017-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLAT_ROTPK_H__
#define __TFM_PLAT_ROTPK_H__
/**
 * \note The interfaces defined in this file must be implemented for each
 *       SoC.
 */

#include <stddef.h>
#include <stdint.h>
#include "tfm_plat_defs.h"
#include "psa/crypto.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Structure to store the hard-coded (embedded in secure firmware) hash of ROTPK
 * for firmware authentication.
 *
 * \note Just temporary solution, hard-coded key-hash values in firmware is not
 *       suited for use in production!
 */
struct tfm_plat_rotpk_t {
    const uint8_t *key_hash;
    const uint8_t  hash_len;
};

/**
 * \brief Get the hash of the corresponding Root of Trust Public Key for
 *        firmware authentication.
 *
 * \param[in]      image_id         The identifier of firmware image
 * \param[out]     rotpk_hash       Buffer to store the key-hash in
 * \param[in,out]  rotpk_hash_size  As input the size of the buffer. As output
 *                                  the actual key-hash length.
 */
enum tfm_plat_err_t
tfm_plat_get_rotpk_hash(uint8_t image_id,
                        uint8_t *rotpk_hash,
                        uint32_t *rotpk_hash_size);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PLAT_ROTPK_H__ */
