/***
 * @Author       : Cole
 * @Date         : 2026-03-03 17:06:05
 * @LastEditTime : 2026-03-04 16:29:31
 * @FilePath     : mos_components/mos_gx8002/app/include/mos_i2s_slave.h
 * @Description  : MOS I2S slave driver (GX8002 VAD path) - nRF as I2S slave
 * @
 * @ Copyright (c) MentraOS Contributors 2026
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_I2S_SLAVE_H_
#define MOS_I2S_SLAVE_H_

#include <stdbool.h>
/***
 * @brief  Initialize I2S slave
 * @return 0 on success, error code otherwise
 */
int gx8002_i2s_init(void);
/***
 * @brief  Start I2S slave
 * @return 0 on success, error code otherwise
 */
int gx8002_i2s_start(void);
/***
 * @brief  Stop I2S slave
 * @return 0 on success, error code otherwise
 */
int gx8002_i2s_stop(void);
/***
 * @brief  Check if I2S slave is started
 * @return true if started, false otherwise
 */
bool gx8002_i2s_is_started(void);

#endif /* MOS_I2S_SLAVE_H_ */
