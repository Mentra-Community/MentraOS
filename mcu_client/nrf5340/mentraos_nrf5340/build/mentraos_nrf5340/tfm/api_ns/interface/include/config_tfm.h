/*
 * Copyright (c) 2022-2023, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __CONFIG_TFM_H__
#define __CONFIG_TFM_H__

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Platform defined header file for TF-M configs.
 * Path: ${TARGET_PLATFORM_PATH}/config_tfm_target.h
 */
#ifdef TARGET_CONFIG_HEADER_FILE
#include TARGET_CONFIG_HEADER_FILE
#endif

#ifdef PROJECT_CONFIG_HEADER_FILE
#include PROJECT_CONFIG_HEADER_FILE
#endif

#include "config_base.h"

#ifdef __cplusplus
}
#endif

#endif /* __CONFIG_TFM_H__ */
