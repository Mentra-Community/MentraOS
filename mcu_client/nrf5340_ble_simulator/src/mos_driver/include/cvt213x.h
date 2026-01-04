/***
 * @Author       : Cole
 * @Date         : 2025-12-30 17:56:07
 * @LastEditTime : 2025-12-30 18:51:26
 * @FilePath     : cvt213x.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

int app_cvt213x_i2c_init(void);
int app_cvt213x_i2c_verify(void);
/* Note: Only i2c3 is used for CVT213X in this build; no runtime bus switching */