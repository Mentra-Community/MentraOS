/***
 * @Author       : Cole
 * @Date         : 2026-02-05 14:53:31
 * @LastEditTime : 2026-02-10 15:46:31
 * @FilePath     : mos_binfont_lvgl.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2026
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_BINFONT_LVGL_H
#define MOS_BINFONT_LVGL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h> /* for off_t */

#if defined(CONFIG_LVGL)
#include <lvgl.h>

/**
 * Get custom Chinese font instance
 * 获取自定义中文字体实例
 * @return LVGL font pointer, or NULL if initialization fails (LVGL字体指针，初始化失败返回NULL)
 */
const lv_font_t *mos_binfont_get_lvgl_font(void);

/**
 * Initialize binfont LVGL font
 * 初始化binfont LVGL字体
 * @return 0 on success, negative error code on failure (0成功，负数错误码)
 */
int mos_binfont_lvgl_init(void);

/**
 * Deinitialize binfont LVGL font and release resources
 * 释放binfont LVGL字体资源
 */
void mos_binfont_lvgl_deinit(void);

/**
 * Debug: get glyph region in Flash
 * 调试：获取字形在Flash中的区域
 * @param unicode Unicode code point (Unicode码点)
 * @param out_glyph_id Output glyph ID (输出glyph ID)
 * @param out_start Output start offset (输出起始偏移)
 * @param out_len Output length (输出长度)
 * @return 0 on success, negative error code on failure (0成功，负数错误码)
 */
int mos_binfont_debug_glyph_region(uint32_t unicode, uint32_t *out_glyph_id, uint32_t *out_start, uint32_t *out_len);

/**
 * Switch language and font size at runtime
 * 切换语言和字体大小（运行时动态切换）
 * @param language Language code (MOS_FONT_LANG_ZH_CN / MOS_FONT_LANG_EN_US) (语言代码)
 * @param font_size Font size (16/20/24) (字体大小)
 * @return 0 on success, negative error code on failure (0成功，负数错误码)
 */
int mos_binfont_switch_language(uint8_t language, uint8_t font_size);

/**
 * Get current language
 * 获取当前语言
 * @return Current language code (当前语言代码)
 */
uint8_t mos_binfont_get_current_language(void);

/**
 * Get current font size
 * 获取当前字体大小
 * @return Current font size (当前字体大小)
 */
uint8_t mos_binfont_get_current_size(void);

/**
 * Read data from current active font partition
 * 从当前激活的字体分区读取数据
 * @param offset Offset (偏移量)
 * @param buf Data buffer (数据缓冲区)
 * @param len Read length (读取长度)
 * @return 0 on success, negative error code on failure (0成功，负数错误码)
 */
int mos_binfont_get_current_partition_data(off_t offset, void *buf, size_t len);

/**
 * Get current font partition ID
 * 获取当前字体分区 ID
 * @return Partition ID, negative value on failure (分区ID，失败返回负数)
 */
int mos_binfont_get_current_partition_id(void);

/**
 * Check whether font storage is initialized
 * 检查字库是否已初始化
 * @return true if initialized, false otherwise (true已初始化，false未初始化)
 */
bool mos_binfont_is_initialized(void);

/**
 * Get font size from storage
 * 获取字库字体大小
 * @return Font size (pt), or 0 if not initialized (字体大小pt，未初始化返回0)
 */
uint16_t mos_binfont_get_font_size(void);

/**
 * Get font ascent value
 * 获取字库 ascent 值
 * @return Ascent value, or 0 if not initialized (ascent值，未初始化返回0)
 */
int16_t mos_binfont_get_ascent(void);

/**
 * Get font descent value
 * 获取字库 descent 值
 * @return Descent value, or 0 if not initialized (descent值，未初始化返回0)
 */
int16_t mos_binfont_get_descent(void);

/**
 * Get font glyph ID format
 * 获取字库 glyph ID 格式
 * @return Glyph ID bit width (8/16), or 0 if not initialized (glyph ID格式位数8/16，未初始化返回0)
 */
uint8_t mos_binfont_get_glyph_id_format(void);

/**
 * Get font bits per pixel
 * 获取字库每像素位数
 * @return Bits per pixel (1/2/4/8), or 0 if not initialized (每像素位数1/2/4/8，未初始化返回0)
 */
uint8_t mos_binfont_get_bits_per_pixel(void);

#endif /* CONFIG_LVGL */

#endif /* MOS_BINFONT_LVGL_H */
