/*** 
 * @Author       : Cole
 * @Date         : 2026-02-05 19:59:05
 * @LastEditTime : 2026-02-07 15:00:09
 * @FilePath     : mos_xbf_font.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#pragma once

#include <lvgl.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Return XBF font instance (XIP from external flash).
 * Returns NULL if font not ready or header invalid.
 */
const lv_font_t* mos_xbf_get_font(void);

#ifdef __cplusplus
}
#endif
