/*
 * Copyright (c) 2017-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLAT_DEFS_H__
#define __TFM_PLAT_DEFS_H__
/**
 * \note The interfaces defined in this file must be implemented for each
 *       target.
 */

#include <stdint.h>
#include <limits.h>

enum tfm_plat_err_t {
    TFM_PLAT_ERR_SUCCESS = 0,
    TFM_PLAT_ERR_SYSTEM_ERR = 0x3A5C,
    TFM_PLAT_ERR_MAX_VALUE = 0x55A3,
    TFM_PLAT_ERR_INVALID_INPUT = 0xA3C5,
    TFM_PLAT_ERR_UNSUPPORTED = 0xC35A,
    TFM_PLAT_ERR_NOT_PERMITTED = 0xC5A3,
    /* Following entry is only to ensure the error code of int size */
    TFM_PLAT_ERR_FORCE_INT_SIZE = INT_MAX
};

#if defined(TFM_ISOLATION_LEVEL) && (TFM_ISOLATION_LEVEL != 1)

/*!
 * \def TFM_LINK_SET_RO_IN_PARTITION_SECTION(TFM_PARTITION_NAME)
 *
 * \brief This macro provides a mechanism to place a function code or a data
 *        variable in the code section (e.g. RO) of a specific secure partition
 *        at linker time.
 *
 * \param[in] TFM_PARTITION_NAME  TF-M partition name assigned in the manifest
 *                                file "name" field.
 * \param[in] TFM_PARTITION_TYPE  TF-M partition type assigned in the manifest
 *                                file "type" field.
 */
#define TFM_LINK_SET_RO_IN_PARTITION_SECTION(TFM_PARTITION_NAME, \
                                             TFM_PARTITION_TYPE) \
    __attribute__((section(TFM_PARTITION_NAME "_" TFM_PARTITION_TYPE "_ATTR_FN")))

/*!
 * \def TFM_LINK_SET_RW_IN_PARTITION_SECTION(TFM_PARTITION_NAME)
 *
 * \brief This macro provides a mechanism to place data variables in the RW data
 *        section of a specific secure partition at linker time.
 *
 * \param[in] TFM_PARTITION_NAME  TF-M partition name assigned in the manifest
 *                                file "name" field.
 * \param[in] TFM_PARTITION_TYPE  TF-M partition type assigned in the manifest
 *                                file "type" field.
 */
#define TFM_LINK_SET_RW_IN_PARTITION_SECTION(TFM_PARTITION_NAME, \
                                             TFM_PARTITION_TYPE) \
    __attribute__((section(TFM_PARTITION_NAME "_" TFM_PARTITION_TYPE "_ATTR_RW")))

/*!
 * \def TFM_LINK_SET_ZI_IN_PARTITION_SECTION(TFM_PARTITION_NAME)
 *
 * \brief This macro provides a mechanism to place data variables in the ZI data
 *        section of a specific secure partition at linker time.
 *
 * \param[in] TFM_PARTITION_NAME  TF-M partition name assigned in the manifest
 *                                file "name" field.
 * \param[in] TFM_PARTITION_TYPE  TF-M partition type assigned in the manifest
 *                                file "type" field.
 */
#define TFM_LINK_SET_ZI_IN_PARTITION_SECTION(TFM_PARTITION_NAME, \
                                             TFM_PARTITION_TYPE) \
    __attribute__((section(TFM_PARTITION_NAME "_" TFM_PARTITION_TYPE "_ATTR_ZI")))
#else
#define TFM_LINK_SET_RO_IN_PARTITION_SECTION(TFM_PARTITION_NAME, TFM_PARTITION_TYPE)
#define TFM_LINK_SET_RW_IN_PARTITION_SECTION(TFM_PARTITION_NAME, TFM_PARTITION_TYPE)
#define TFM_LINK_SET_ZI_IN_PARTITION_SECTION(TFM_PARTITION_NAME, TFM_PARTITION_TYPE)
#endif
#endif /* __TFM_PLAT_DEFS_H__ */
