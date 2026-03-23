/*
 * Copyright (c) 2023 Cypress Semiconductor Corporation (an Infineon company)
 * or an affiliate of Cypress Semiconductor Corporation. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

/* This file provides implementation of TF-M NS os wrapper functions for the
 * bare metal use case.
 *
 * \note  This implementation does not provide multithread safety, so it
 *        shouldn't be used in RTOS environment.
 */

#include "tfm_ns_interface.h"

int32_t tfm_ns_interface_dispatch(veneer_fn fn,
                                  uint32_t arg0, uint32_t arg1,
                                  uint32_t arg2, uint32_t arg3)
{
    return fn(arg0, arg1, arg2, arg3);
}
