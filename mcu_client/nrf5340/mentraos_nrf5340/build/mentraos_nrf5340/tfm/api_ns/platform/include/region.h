/*
 * Copyright (c) 2020-2021, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __REGION_H__
#define __REGION_H__

#include <stdint.h>

/* Macros to pick linker symbols */
#define REGION(a, b, c) a##b##c
#define REGION_NAME(a, b, c) REGION(a, b, c)
#define REGION_DECLARE(a, b, c) extern uint32_t REGION_NAME(a, b, c)
#define REGION_DECLARE_T(a, b, c, t) extern t REGION_NAME(a, b, c)

#ifdef __ICCARM__
/*
 * ARMCLANG - IAR linker compatibility
 */
#define Image$$
#define Load$$LR$$
#define $$ZI$$Base $$Base
#define $$ZI$$Limit $$Limit
#define $$RO$$Base $$Base
#define $$RO$$Limit $$Limit
#define $$RW$$Base $$Base
#define $$RW$$Limit $$Limit
#define _DATA$$RW$$Base _DATA$$Base
#define _DATA$$RW$$Limit _DATA$$Limit
#define _DATA$$ZI$$Base _DATA$$Base
#define _DATA$$ZI$$Limit _DATA$$Limit
#define _STACK$$ZI$$Base _STACK$$Base
#define _STACK$$ZI$$Limit _STACK$$Limit

#endif  /* __ICCARM__ */

#endif  /* __REGION_H__ */
