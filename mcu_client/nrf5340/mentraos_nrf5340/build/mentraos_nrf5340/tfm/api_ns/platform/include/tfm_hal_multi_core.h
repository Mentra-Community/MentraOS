/*
 * Copyright (c) 2021-2024, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_HAL_MULTI_CORE_H__
#define __TFM_HAL_MULTI_CORE_H__

#include <stddef.h>
#include <stdint.h>

#include "tfm_multi_core.h"

/**
 * \brief Performs the necessary actions to start the non-secure CPU running
 *        the code at the specified address.
 *
 * \param[in] start_addr       The entry point address of non-secure code.
 */
void tfm_hal_boot_ns_cpu(uintptr_t start_addr);

/**
 * \brief Called on the secure CPU.
 *        Flags that the secure CPU has completed its initialization
 *        Waits, if necessary, for the non-secure CPU to flag that
 *        it has completed its initialisation
 */
void tfm_hal_wait_for_ns_cpu_ready(void);

/**
 * \brief Retrieve the current active security configuration information and
 *        fills the \ref security_attr_info_t.
 *
 * \param[in]  p               Base address of target memory region
 * \param[in]  s               Size of target memory region
 * \param[out] p_attr          Address of \ref security_attr_info_t to be filled
 *
 * \return void
 */
void tfm_hal_get_mem_security_attr(const void *p, size_t s,
                                   struct security_attr_info_t *p_attr);

/**
 * \brief Retrieve the secure memory protection configuration information and
 *        fills the \ref mem_attr_info_t.
 *
 * \param[in]  p               Base address of target memory region
 * \param[in]  s               Size of target memory region
 * \param[out] p_attr          Address of \ref mem_attr_info_t to be filled
 *
 * \return void
 */
void tfm_hal_get_secure_access_attr(const void *p, size_t s,
                                    struct mem_attr_info_t *p_attr);

/**
 * \brief Retrieve the non-secure memory protection configuration information
 *        and fills the \ref mem_attr_info_t.
 *
 * \param[in]  p               Base address of target memory region
 * \param[in]  s               Size of target memory region
 * \param[out] p_attr          Address of \ref mem_attr_info_t to be filled
 *
 * \return void
 */
void tfm_hal_get_ns_access_attr(const void *p, size_t s,
                                struct mem_attr_info_t *p_attr);

#endif /* __TFM_HAL_MULTI_CORE_H__ */
