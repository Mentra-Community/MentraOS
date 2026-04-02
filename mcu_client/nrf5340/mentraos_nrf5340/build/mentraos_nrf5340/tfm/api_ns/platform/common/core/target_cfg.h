/*
 * Copyright (c) 2017-2019 Arm Limited
 * Copyright (c) 2020 Nordic Semiconductor ASA
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef __TARGET_CFG_H__
#define __TARGET_CFG_H__

/**
 * \file target_cfg.h
 * \brief Target configuration header
 *
 * This file contains the platform specific functions to configure
 * the Cortex-M33 core, memory permissions and security attribution.
 * on the nordic_nrf platform.
 *
 * Memory permissions and security attribution are configured via
 * the System Protection Unit (SPU) which is the nRF specific Implementation
 * Defined Attribution Unit (IDAU).
 */


#include "tfm_plat_defs.h"
#include "region_defs.h"

#if NRF_SECURE_UART_INSTANCE == 0
#define TFM_DRIVER_STDIO    Driver_USART0
#elif NRF_SECURE_UART_INSTANCE == 1
#define TFM_DRIVER_STDIO    Driver_USART1
#elif NRF_SECURE_UART_INSTANCE == 00
#define TFM_DRIVER_STDIO    Driver_USART00
#elif NRF_SECURE_UART_INSTANCE == 20
#define TFM_DRIVER_STDIO    Driver_USART20
#elif NRF_SECURE_UART_INSTANCE == 21
#define TFM_DRIVER_STDIO    Driver_USART21
#elif NRF_SECURE_UART_INSTANCE == 22
#define TFM_DRIVER_STDIO    Driver_USART22
#elif NRF_SECURE_UART_INSTANCE == 30
#define TFM_DRIVER_STDIO    Driver_USART30
#endif

/* Only UART20 and UART30 are supported for TF-M tests, which are the
 * Non-secure applications build via the TF-M build system
 */
#ifdef NRF54L15_XXAA
#if NRF_SECURE_UART_INSTANCE == 20
#define NS_DRIVER_STDIO     Driver_USART30
#else
#define NS_DRIVER_STDIO     Driver_USART20
#endif
#else
#define NS_DRIVER_STDIO     Driver_USART0
#endif /* NRF54L15_XXAA */

/**
 * \brief Store the addresses of memory regions
 */
struct memory_region_limits {
    uint32_t non_secure_code_start;
    uint32_t non_secure_partition_base;
    uint32_t non_secure_partition_limit;
    uint32_t veneer_base;
    uint32_t veneer_limit;
#ifdef NRF_NS_SECONDARY
    uint32_t secondary_partition_base;
    uint32_t secondary_partition_limit;
#endif /* NRF_NS_SECONDARY */
#ifdef NRF_NS_STORAGE_PARTITION_START
    uint32_t non_secure_storage_partition_base;
    uint32_t non_secure_storage_partition_limit;
#endif /* NRF_NS_STORAGE_PARTITION_START */
};

/**
 * \brief Holds the data necessary to do isolation for a specific peripheral.
 */
struct platform_data_t
{
    uint32_t periph_start;
    uint32_t periph_limit;
};

/**
 * \brief Configures memory permissions via the System Protection Unit.
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t spu_init_cfg(void);

/**
 * \brief Configures peripheral permissions via the System Protection Unit.
 *
 * The function does the following:
 * - grants Non-Secure access to nRF peripherals that are not Secure-only
 * - grants Non-Secure access to DDPI channels
 * - grants Non-Secure access to GPIO pins
 * - On nrf5340 enforces that the external domain is still at the HW reset value
 *   of non-secure and locking it
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t spu_periph_init_cfg(void);

/**
 * \brief Configures memory permissions via the MPC.
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t nrf_mpc_init_cfg(void);

/**
 * \brief Configures SAU and IDAU.
 */
void sau_and_idau_cfg(void);

/**
 * \brief Enables the fault handlers and sets priorities.
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t enable_fault_handlers(void);

/**
 * \brief Configures the system reset request properties
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t system_reset_cfg(void);

/**
 * \brief Configures the system debug properties.
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t init_debug(void);

/**
 * \brief Configures all external interrupts to target the
 *        NS state, apart for the ones associated to secure
 *        peripherals (plus SPU)
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t nvic_interrupt_target_state_cfg(void);

/**
 * \brief This function enable the interrupts associated
 *        to the secure peripherals (plus the isolation boundary violation
 *        interrupts)
 *
 * \return Returns values as specified by the \ref tfm_plat_err_t
 */
enum tfm_plat_err_t nvic_interrupt_enable(void);

#endif /* __TARGET_CFG_H__ */
