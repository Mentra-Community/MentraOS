/*
 * Copyright (c) 2020-2021, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_HAL_DEFS_H__
#define __TFM_HAL_DEFS_H__

#include <limits.h>
#include <stdint.h>

enum tfm_hal_status_t {
    TFM_HAL_ERROR_MEM_FAULT = SCHAR_MIN,
    TFM_HAL_ERROR_MAX_VALUE = SCHAR_MIN + 0x3A5C,
    TFM_HAL_ERROR_BAD_STATE = SCHAR_MIN + 0x55A3,
    TFM_HAL_ERROR_NOT_SUPPORTED = SCHAR_MIN + 0xA3C5,
    TFM_HAL_ERROR_INVALID_INPUT = SCHAR_MIN + 0xC35A,
    TFM_HAL_ERROR_NOT_INIT = SCHAR_MIN + 0x33CA5,
    TFM_HAL_ERROR_GENERIC = SCHAR_MIN + 0x3C5A,
    TFM_HAL_SUCCESS = 0
};

#endif /* __TFM_HAL_DEFS_H__ */
