/*
 * Copyright (c) 2020, Cypress Semiconductor Corporation. All rights reserved.
 * Copyright (c) 2020-2021, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_HAL_ITS_H__
#define __TFM_HAL_ITS_H__

#include <stddef.h>
#include <stdint.h>

#include "Driver_Flash.h"
#include "flash_layout.h"
#include "tfm_hal_defs.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The name of the ARM_DRIVER_FLASH to use for ITS */
#ifndef TFM_HAL_ITS_FLASH_DRIVER
#error "TFM_HAL_ITS_FLASH_DRIVER must be defined by the target in flash_layout.h"
#endif

/* The size of the ITS flash device's physical program unit. Must be equal to
 * TFM_HAL_ITS_FLASH_DRIVER.GetInfo()->program_unit, but required at compile
 * time.
 */
#ifndef TFM_HAL_ITS_PROGRAM_UNIT
#error "TFM_HAL_ITS_PROGRAM_UNIT must be defined by the target in flash_layout.h"
#elif (TFM_HAL_ITS_PROGRAM_UNIT < 1)
#error "TFM_HAL_ITS_PROGRAM_UNIT must be greater than 1"
#elif (TFM_HAL_ITS_PROGRAM_UNIT & (TFM_HAL_ITS_PROGRAM_UNIT - 1) != 0)
#error "TFM_HAL_ITS_PROGRAM_UNIT must be a power of two"
#endif

/**
 * \brief Struct containing information required from the platform at runtime
 *        to configure the ITS filesystem.
 */
struct tfm_hal_its_fs_info_t {
    uint32_t flash_area_addr;  /**< Location of the block of flash to use for
                                *   ITS
                                */
    size_t flash_area_size;    /**< Number of bytes of flash to use for ITS */
    uint8_t sectors_per_block; /**< Number of erase sectors per logical FS block
                                */
};

/**
 * \brief The flash driver to use for ITS.
 */
extern ARM_DRIVER_FLASH TFM_HAL_ITS_FLASH_DRIVER;

/**
 * \brief Retrieve the filesystem config for ITS.
 *
 * Note that this function should ensure that the values returned do
 * not result in a security compromise.
 *
 * \param [out] fs_info  Filesystem config information
 *
 * \return A status code as specified in \ref tfm_hal_status_t
 * If an error is detected within this function, is should leave the
 * content of the parameters unchanged.
 *
 * \retval TFM_HAL_SUCCESS              The operation completed successfully
 * \retval TFM_HAL_ERROR_INVALID_INPUT  Invalid parameter
 */
enum tfm_hal_status_t
tfm_hal_its_fs_info(struct tfm_hal_its_fs_info_t *fs_info);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_HAL_ITS_H__ */
