/*
 * Copyright (c) 2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __CMSIS_OVERRIDE_H__
#define __CMSIS_OVERRIDE_H__

#if defined(__GNUC__)

#define __INITIAL_SP    Image$$ARM_LIB_STACK$$ZI$$Limit
#define __STACK_LIMIT   Image$$ARM_LIB_STACK$$ZI$$Base

#elif defined(__ICCARM__)

#define __INITIAL_SP    ARM_LIB_STACK$$Limit
#define __STACK_LIMIT   ARM_LIB_STACK$$Base

#endif

#endif /* __CMSIS_OVERRIDE_H__ */
