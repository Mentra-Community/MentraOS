/***
 * @Author       : XK
 * @Date         : 2025-05-10 14:20:34
 * @LastEditTime : 2025-07-10 09:51:59
 * @FilePath     : xyzn_config.h
 * @Description  :
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#ifndef _XYZN_CONGFIG_H
#define _XYZN_CONFIG_H

/*-------------------------------------------------------------------------------------------------------------*/
#define XYZN_PROJECT_NAME       "K901_NRF5340"
#define XYZN_HARDWARE_VERSION   "V_001"
/*
 *   第一个版本号：大版本（正式发布）
 *   第二个版本号：小版本（修复大版本的bug）
 *   第三个版本号：每次修改后，提交代码，这里都需要+1（研发调试使用）
 *   注意：每次对外发布版本后，第三个版本号需要置0
 */
#define XYZN_FIRMWARE_VERSION "K901_NRF5340-V0_0_2-2500710"

// #define XYZN_FIRMWARE_BUILD   "1"//每次修改提交代码，这里都需要+1
#define XYZN_COMPILE_DATE   __DATE__
#define XYZN_COMPILE_TIME   __TIME__
#define XYZN_SDK_VERSION    "NCS 3.0.0"




#endif /* _XYZN_CONGFIG_H */