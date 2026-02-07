/*** 
 * @Author       : Cole
 * @Date         : 2026-02-05 14:53:31
 * @LastEditTime : 2026-02-07 15:00:23
 * @FilePath     : mos_binfont_lvgl.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_BINFONT_LVGL_H
#define MOS_BINFONT_LVGL_H

#include <stdbool.h>
#include <stdint.h>

#if defined(CONFIG_LVGL)
#include <lvgl.h>

/**
 * 获取自定义中文字体实例
 * @return LVGL字体指针，如果初始化失败返回NULL
 */
const lv_font_t* mos_binfont_get_lvgl_font(void);

/**
 * 初始化binfont LVGL字体
 * @return 0成功，负数错误码
 */
int mos_binfont_lvgl_init(void);

/**
 * 释放binfont LVGL字体资源
 */
void mos_binfont_lvgl_deinit(void);

#endif /* CONFIG_LVGL */

#endif /* MOS_BINFONT_LVGL_H */
