/***
 * @Author       : Cole
 * @Date         : 2025-12-03 11:35:52
 * @LastEditTime : 2025-12-03 15:08:02
 * @FilePath     : gx8002_update.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _GX8002_UPDATE_H_
#define _GX8002_UPDATE_H_

#include <stdint.h>
#include <zephyr/kernel.h>

/**
 * @brief GX8002 firmware update via I2C OTA
 * @param firmware_data Pointer to firmware data array (must not be NULL)
 * @param firmware_len Firmware data length (must be > 0)
 * @return 1 on success, 0 on failure
 *
 * This function performs the complete OTA update process:
 * 1. Check current firmware version
 * 2. Reset chip
 * 3. Handshake
 * 4. Download boot stage1
 * 5. Download boot stage2
 * 6. Download flash image
 *
 * Note: firmware_data and firmware_len are required parameters.
 * Available firmware versions: v07, v08 (defined in gx8002_firmware_data.h)
 */
uint8_t gx8002_fw_update(const uint8_t* firmware_data, uint32_t firmware_len);

#endif /* _GX8002_UPDATE_H_ */

