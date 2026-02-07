/*** 
 * @Author       : Cole
 * @Date         : 2026-02-05 14:53:31
 * @LastEditTime : 2026-02-07 15:00:46
 * @FilePath     : mos_font_storage.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_FONT_STORAGE_H
#define MOS_FONT_STORAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#if defined(CONFIG_LVGL)
#include <lvgl.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

int mos_font_storage_load(void);
bool mos_font_storage_is_loaded(void);
void mos_font_storage_unload(void);

#if defined(CONFIG_LVGL)
const lv_font_t *mos_font_storage_get_lv_font(void);
#endif

#ifdef __cplusplus
}
#endif

#endif /* MOS_FONT_STORAGE_H */
