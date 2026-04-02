/*
 * Copyright (c) 2020, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */
#ifndef __TFM_PLAT_CONFIG_H__
#define __TFM_PLAT_CONFIG_H__

#ifdef __cplusplus
extern "C" {
#endif

/* Enable the multiple data section copy and bss section clear feature
 * in GNUARM low level start-up.
 */
#define __STARTUP_COPY_MULTIPLE
#define __STARTUP_CLEAR_BSS_MULTIPLE

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PLAT_CONFIG_H__ */