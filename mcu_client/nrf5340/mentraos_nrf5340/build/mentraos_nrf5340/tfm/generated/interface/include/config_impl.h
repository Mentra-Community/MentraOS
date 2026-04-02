/*
 * Copyright (c) 2021-2022, Arm Limited. All rights reserved.
 * Copyright (c) 2024, Cypress Semiconductor Corporation (an Infineon company)
 * or an affiliate of Cypress Semiconductor Corporation. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */
/***********  WARNING: This is an auto-generated file. Do not edit!  ***********/

#ifndef __CONFIG_IMPL_H__
#define __CONFIG_IMPL_H__

#include "config_tfm.h"

/* Backends */
#define CONFIG_TFM_SPM_BACKEND_IPC                               0
#define CONFIG_TFM_SPM_BACKEND_SFN                               1

#define CONFIG_TFM_CONNECTION_BASED_SERVICE_API                  0
#define CONFIG_TFM_MMIO_REGION_ENABLE                            0
#define CONFIG_TFM_FLIH_API                                      0
#define CONFIG_TFM_SLIH_API                                      0

#if CONFIG_TFM_SPM_BACKEND_IPC == 1
/* Trustzone NS agent working stack size. */
#if defined(TFM_FIH_PROFILE_ON) && TFM_ISOLATION_LEVEL == 1
#define CONFIG_TFM_NS_AGENT_TZ_STACK_SIZE                        1256
#else
#define CONFIG_TFM_NS_AGENT_TZ_STACK_SIZE                        1024
#endif

#if !defined CONFIG_TFM_USE_TRUSTZONE
/* SPM has to have its own stack if Trustzone isn't present. */
#if defined(TFM_FIH_PROFILE_ON)
#define CONFIG_TFM_SPM_THREAD_STACK_SIZE                          1536
#else
#define CONFIG_TFM_SPM_THREAD_STACK_SIZE                          1024
#endif
#endif

#elif CONFIG_TFM_SPM_BACKEND_SFN == 1
/*
 * In isolation level 1 SFN model, all subsequent components work on NS agent
 * stack. It is observed that half of the sum of all partition stack sizes is
 * enough for working. Define a divisor factor
 * CONFIG_TFM_NS_AGENT_TZ_STK_SIZE_SHIFT_FACTOR for reference, and allow
 * modification of the factor based on application situation. The stack size
 * value is aligned to 8 bytes.
 * The minimum value is 0x400 to satisfy the SPM functional requirement.
 * Manifest tool will assure this.
 */
#define CONFIG_TFM_TOTAL_STACK_SIZE                              (0 + CRYPTO_STACK_SIZE + PLATFORM_SP_STACK_SIZE)
#if (CONFIG_TFM_TOTAL_STACK_SIZE < 2048)
#undef CONFIG_TFM_TOTAL_STACK_SIZE                             
#define CONFIG_TFM_TOTAL_STACK_SIZE                              2048
#endif

#define CONFIG_TFM_NS_AGENT_TZ_STK_SIZE_SHIFT_FACTOR             1
#define CONFIG_TFM_NS_AGENT_TZ_STACK_SIZE                         \
    (((CONFIG_TFM_TOTAL_STACK_SIZE >> CONFIG_TFM_NS_AGENT_TZ_STK_SIZE_SHIFT_FACTOR) + 0x7) & (~0x7))

#endif /* CONFIG_TFM_SPM_BACKEND_IPC == 1 */

/* Define whether ARoT partitions are present. Can be used when applying protections. */
#define CONFIG_TFM_AROT_PRESENT                                  0

#endif /* __CONFIG_IMPL_H__ */
