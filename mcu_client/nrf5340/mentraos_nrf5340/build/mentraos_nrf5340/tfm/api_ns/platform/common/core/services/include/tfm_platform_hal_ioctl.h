/*
 * Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

/** @file
 * @brief TFM IOCTL API header.
 */


#ifndef TFM_PLATFORM_HAL_IOCTL_H__
#define TFM_PLATFORM_HAL_IOCTL_H__

#include "psa/client.h"
#include "tfm_plat_defs.h"

#ifdef __cplusplus
extern "C" {
#endif

enum tfm_platform_err_t
tfm_platform_hal_read_service(const psa_invec  *in_vec,
			      const psa_outvec *out_vec);

enum tfm_platform_err_t
tfm_platform_hal_gpio_service(const psa_invec  *in_vec, const psa_outvec *out_vec);


enum tfm_platform_err_t
tfm_platform_hal_write32_service(const psa_invec  *in_vec,
				 const psa_outvec *out_vec);

#ifdef __cplusplus
}
#endif

#endif /* TFM_IOCTL_API_H__ */
