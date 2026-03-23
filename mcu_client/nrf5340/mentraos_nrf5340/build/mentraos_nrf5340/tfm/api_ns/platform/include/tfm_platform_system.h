/*
 * Copyright (c) 2018-2021, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLATFORM_SYSTEM_H__
#define __TFM_PLATFORM_SYSTEM_H__
/**
 * \note The interfaces defined in this file must be implemented for each
 *       target.
 */

#include "psa/client.h"
#include "tfm_plat_defs.h"
#include "tfm_platform_api.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * \brief Resets the system.
 *
 * \details Requests a system reset to reset the MCU.
 */
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_PLATFORM", "PSA-ROT")
void tfm_platform_hal_system_reset(void);

/*!
 * \brief Performs a platform-specific service
 *
 * \param[in]  request      Request identifier (valid values vary
 *                          based on the platform)
 * \param[in]  in_vec       Input buffer to the requested service (or NULL)
 * \param[out] out_vec      Output buffer to the requested service (or NULL)
 *
 * \return Returns values as specified by the \ref tfm_platform_err_t
 */
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_PLATFORM", "PSA-ROT")
enum tfm_platform_err_t tfm_platform_hal_ioctl(tfm_platform_ioctl_req_t request,
                                               psa_invec *in_vec,
                                               psa_outvec *out_vec);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PLATFORM_SYSTEM_H__ */
