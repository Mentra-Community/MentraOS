/*
 * Copyright (c) 2021, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */
#ifndef __TFM_PLAT_CRYPTO_NV_SEED_H__
#define __TFM_PLAT_CRYPTO_NV_SEED_H__

#include <stddef.h>

#ifndef NV_SEED_FILE_ID
#define NV_SEED_FILE_ID 9
#endif

#define TFM_CRYPTO_NV_SEED_SUCCESS 0
#define TFM_CRYPTO_NV_SEED_FAILED  -1

/**
 * \brief Provision Seed to NV storage. Fails if a seed is already in storage.
 *
 * \return Return TFM_CRYPTO_NV_SEED_SUCCESS on success,
 *         or TFM_CRYPTO_NV_SEED_FAILED on failure.
 */
int tfm_plat_crypto_provision_entropy_seed(void);

/**
 * \brief Read Seed from NV storage.
 *
 * \param[out] buf        Buffer to store the seed
 * \param[in]  buf_len    Buffer length to read
 *
 * \return Return TFM_CRYPTO_NV_SEED_SUCCESS on success,
 *         or TFM_CRYPTO_NV_SEED_FAILED on failure.
 */
int tfm_plat_crypto_nv_seed_read(unsigned char *buf, size_t buf_len);

/**
 * \brief Write Seed to NV storage.
 *
 * \param[in]  buf        Buffer storing the seed
 * \param[in]  buf_len    Buffer length to write
 *
 * \return Return TFM_CRYPTO_NV_SEED_SUCCESS on success,
 *         or TFM_CRYPTO_NV_SEED_FAILED on failure.
 */
int tfm_plat_crypto_nv_seed_write(const unsigned char *buf, size_t buf_len);

#endif /* __TFM_PLAT_CRYPTO_NV_SEED_H__ */
