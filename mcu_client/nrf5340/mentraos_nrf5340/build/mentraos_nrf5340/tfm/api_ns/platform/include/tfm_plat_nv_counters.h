/*
 * Copyright (c) 2018-2023, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLAT_NV_COUNTERS_H__
#define __TFM_PLAT_NV_COUNTERS_H__

/**
 * \file tfm_plat_nv_counters.h
 *
 * \note The interfaces defined in this file must be implemented for each
 *       SoC.
 * \note The interface must be implemented in a fail-safe way that is
 *       resistant to asynchronous power failures or it can use hardware
 *       counters that have this capability, if supported by the platform.
 *       When a counter incrementation was interrupted it must be able to
 *       continue the incrementation process or recover the previous consistent
 *       status of the counters. If the counters have reached a stable status
 *       (every counter incrementation operation has finished), from that point
 *       their value cannot decrease due to any kind of power failure.
 */

#include <stdint.h>
#include "tfm_plat_defs.h"

#ifndef PLATFORM_NS_NV_COUNTERS
#define PLATFORM_NS_NV_COUNTERS 0
#endif

#ifdef PLATFORM_DEFAULT_NV_COUNTERS
enum tfm_nv_counter_t {
    PLAT_NV_COUNTER_PS_0 = 0,  /* Used by PS service */
    PLAT_NV_COUNTER_PS_1,      /* Used by PS service */
    PLAT_NV_COUNTER_PS_2,      /* Used by PS service */

    /* BL2 NV counters must be contiguous */
    PLAT_NV_COUNTER_BL2_0,     /* Used by bootloader */
    PLAT_NV_COUNTER_BL2_1,     /* Used by bootloader */
    PLAT_NV_COUNTER_BL2_2,     /* Used by bootloader */
    PLAT_NV_COUNTER_BL2_3,     /* Used by bootloader */

    PLAT_NV_COUNTER_BL1_0,     /* Used by bootloader */

    /* NS counters must be contiguous */
    PLAT_NV_COUNTER_NS_0,      /* Used by NS */
    PLAT_NV_COUNTER_NS_1,      /* Used by NS */
    PLAT_NV_COUNTER_NS_2,      /* Used by NS */

    PLAT_NV_COUNTER_MAX,
    PLAT_NV_COUNTER_BOUNDARY = UINT32_MAX  /* Fix  tfm_nv_counter_t size
                                              to 4 bytes */
};
#else
#include "platform_nv_counters_ids.h"
#endif

#ifdef __cplusplus
extern "C" {
#endif

/**
 * \brief Initialises all non-volatile (NV) counters.
 *
 * \return  TFM_PLAT_ERR_SUCCESS if the initialization succeeds, otherwise
 *          TFM_PLAT_ERR_SYSTEM_ERR
 */
enum tfm_plat_err_t tfm_plat_init_nv_counter(void);

/**
 * \brief Reads the given non-volatile (NV) counter.
 *
 * \param[in]  counter_id  NV counter ID.
 * \param[in]  size        Size of the buffer to store NV counter value
 *                         in bytes.
 * \param[out] val         Pointer to store the current NV counter value.
 *
 * \return  TFM_PLAT_ERR_SUCCESS if the value is read correctly. Otherwise,
 *          it returns TFM_PLAT_ERR_SYSTEM_ERR.
 */
enum tfm_plat_err_t tfm_plat_read_nv_counter(enum tfm_nv_counter_t counter_id,
                                             uint32_t size, uint8_t *val);

/**
 * \brief Increments the given non-volatile (NV) counter.
 *
 * \param[in] counter_id  NV counter ID.
 *
 * \return  When the NV counter reaches its maximum value, the
 *          TFM_PLAT_ERR_MAX_VALUE error is returned to indicate the value
 *          cannot be incremented. Otherwise, it returns TFM_PLAT_ERR_SUCCESS.
 */
enum tfm_plat_err_t tfm_plat_increment_nv_counter(
                                              enum tfm_nv_counter_t counter_id);

/**
 * \brief Sets the given non-volatile (NV) counter to the specified value.
 *
 * \param[in] counter_id  NV counter ID.
 * \param[in] value       New value of the NV counter. The maximum value that
 *                        can be set depends on the constraints of the
 *                        underlying implementation, but it always must be
 *                        greater than or equal to the current NV counter value.
 *
 * \retval TFM_PLAT_ERR_SUCCESS         The NV counter is set successfully
 * \retval TFM_PLAT_ERR_INVALID_INPUT   The new value is less than the current
 *                                      counter value
 * \retval TFM_PLAT_ERR_MAX_VALUE       The new value is greater than the
 *                                      maximum value of the NV counter
 * \retval TFM_PLAT_ERR_UNSUPPORTED     The function is not implemented for
 *                                      the given platform or the new value is
 *                                      not representable on the underlying
 *                                      counter implementation
 * \retval TFM_PLAT_ERR_SYSTEM_ERR      An unspecified error occurred
 *                                      (none of the other standard error codes
 *                                      are applicable)
 */
enum tfm_plat_err_t tfm_plat_set_nv_counter(enum tfm_nv_counter_t counter_id,
                                            uint32_t value);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PLAT_NV_COUNTERS_H__ */
