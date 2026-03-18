/*
 * Copyright (c) 2021-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */
#ifndef __MBEDTLS_ENTROPY_NV_SEED_CONF_H__
#define __MBEDTLS_ENTROPY_NV_SEED_CONF_H__

#include "tfm_plat_crypto_nv_seed.h"

#ifdef __cplusplus
extern "C" {
#endif /* __cplusplus */

#undef MBEDTLS_NO_DEFAULT_ENTROPY_SOURCES

#define MBEDTLS_ENTROPY_NV_SEED
#ifndef MBEDTLS_PLATFORM_NV_SEED_READ_MACRO
#define MBEDTLS_PLATFORM_NV_SEED_READ_MACRO  tfm_plat_crypto_nv_seed_read
#endif
#ifndef MBEDTLS_PLATFORM_NV_SEED_WRITE_MACRO
#define MBEDTLS_PLATFORM_NV_SEED_WRITE_MACRO tfm_plat_crypto_nv_seed_write
#endif

#ifdef __cplusplus
}
#endif /* __cplusplus */

#endif /* __MBEDTLS_ENTROPY_NV_SEED_CONF_H__ */
