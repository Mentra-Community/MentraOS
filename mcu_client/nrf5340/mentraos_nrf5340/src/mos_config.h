/***
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 15:51:35
 * @FilePath     : mos_config.h
 * @Description  : congig file for MentraOS NRF5340
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _MOS_CONFIG_H_
#define _MOS_CONFIG_H_

/*-------------------------------------------------------------------------------------------------------------*/
#define MOS_PROJECT_NAME "MentraOS_NRF5340"
#define MOS_HARDWARE_VERSION "V_001"
/*
 *   第一个版本号：大版本（正式发布）
 *   第二个版本号：小版本（修复大版本的bug）
 *   第三个版本号：每次修改后，提交代码，这里都需要+1（研发调试使用）
 *   注意：每次对外发布版本后，第三个版本号需要置0
 *
 *First version number: large version (officially released)
 *The second version number: small version (fix large version bugs)
 *The third version number: After each modification, submit the code, +1 is required here (for R&D and debugging)
 *Note: After each release of the version, the third version number needs to be set to 0.
 */
#define MOS_FIRMWARE_VERSION "MentraOS-NRF5340-V1_0_0"

// #define MOS_FIRMWARE_BUILD   "1"//每次修改提交代码，这里都需要+1; set to 0 after each release
#define MOS_COMPILE_DATE __DATE__
#define MOS_COMPILE_TIME __TIME__
#define MOS_SDK_VERSION "NCS 3.0.0"

#endif /* _MOS_CONFIG_H_ */