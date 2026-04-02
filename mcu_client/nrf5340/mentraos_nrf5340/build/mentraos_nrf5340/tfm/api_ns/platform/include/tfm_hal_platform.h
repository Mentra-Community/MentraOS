/*
 * Copyright (c) 2020-2021, Arm Limited. All rights reserved.
 * Copyright (c) 2022 Cypress Semiconductor Corporation (an Infineon company)
 * or an affiliate of Cypress Semiconductor Corporation. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_HAL_PLATFORM_H__
#define __TFM_HAL_PLATFORM_H__

#include <stddef.h>
#include <stdint.h>

#include "fih.h"
#include "tfm_hal_defs.h"

/**
 * \brief This function performs the platform-specific initialization.
 *
 * This function is called after architecture and platform common initialization
 * has finished during system early startup.
 *
 * \retval TFM_HAL_SUCCESS          Init success.
 * \retval TFM_HAL_ERROR_GENERIC    Generic errors.
 */
FIH_RET_TYPE(enum tfm_hal_status_t) tfm_hal_platform_init(void);

/**
 * \brief System reset
 */
void tfm_hal_system_reset(void);

/**
 * \brief System halt
 */
void tfm_hal_system_halt(void);

/**
 * \brief Set up the RNG for use with random delays.
 *
 * \retval TFM_HAL_SUCCESS        Platform specific random number generation
 *                                initialization succeeded.
 * \retval Other code             Initialization failed.
 */
int32_t tfm_hal_random_init(void);

/**
 * \brief Get a random number from an RNG seeded with an entropy source.
 *
 * \param[out] rand               Buffer to hold the random value
 * \param[in] size                The size of the buffer
 *
 * \retval TFM_HAL_SUCCESS        Platform specific random number generation
 *                                succeed.
 * \retval Other code             generation failed.
 */
int32_t tfm_hal_random_generate(uint8_t *rand, size_t size);

/**
 * \brief Get the VTOR value of non-secure image
 *
 * \return Returns the address where the vector table of the non-secure image
 *         is located
 */
uint32_t tfm_hal_get_ns_VTOR(void);

/**
 * \brief Get the entry point of the non-secure image
 *
 * \return Returns the address of the non-secure image entry point
 */
uint32_t tfm_hal_get_ns_entry_point(void);

#ifdef TFM_PARTITION_NS_AGENT_TZ
/**
 * \brief Get the initial address of non-secure image main stack
 *
 * \return Returns the initial non-secure MSP
 */
uint32_t tfm_hal_get_ns_MSP(void);
#endif /* TFM_PARTITION_NS_AGENT_TZ */

#endif /* __TFM_HAL_PLATFORM_H__ */
