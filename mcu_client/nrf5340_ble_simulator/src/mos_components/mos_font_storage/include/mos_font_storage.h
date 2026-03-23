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
extern "C"
{
#endif

    /* Language definitions (aligned with external Flash pm_static partitions: zh_cn + en_us only)
     * 语言定义（与外置 Flash pm_static 分区一致，仅 zh_cn + en_us） */
    typedef enum
    {
        MOS_FONT_LANG_ZH_CN = 1, /* Simplified Chinese, partition font_storage_zh_cn_18, 18pt only (简体中文，仅18pt) */
        MOS_FONT_LANG_EN_US = 2, /* English, partitions font_storage_en_16 ... font_storage_en_26 (英语，多字号分区) */
        MOS_FONT_LANG_MAX = 2
    } mos_font_language_t;

    /* Font size definitions
     * 字体大小定义 */
    typedef enum
    {
        MOS_FONT_SIZE_16 = 16,
        MOS_FONT_SIZE_18 = 18,
        MOS_FONT_SIZE_20 = 20,
        MOS_FONT_SIZE_22 = 22,
        MOS_FONT_SIZE_24 = 24,
        MOS_FONT_SIZE_26 = 26,
        MOS_FONT_SIZE_MAX = 26
    } mos_font_size_t;

    int mos_font_storage_load(void);
    bool mos_font_storage_is_loaded(void);
    void mos_font_storage_unload(void);

#if defined(CONFIG_LVGL)

    /**
     * @brief Font switch callback type
     * 字体切换回调函数类型
     */
    typedef void (*mos_font_change_callback_t)(const lv_font_t *new_font);

    /**
     * @brief Register font switch callback
     * 注册字体切换回调
     * @param callback Callback function pointer (回调函数指针)
     * @return 0 on success, negative value on failure (0成功，负数失败)
     */
    int mos_font_register_change_callback(mos_font_change_callback_t callback);

    /**
     * @brief Unregister font switch callback
     * 注销字体切换回调
     * @param callback Callback function pointer (回调函数指针)
     * @return 0 on success, negative value on failure (0成功，负数失败)
     */
    int mos_font_unregister_change_callback(mos_font_change_callback_t callback);

    const lv_font_t *mos_font_storage_get_lvgl_font(void);

    /**
     * @brief Switch language and font size at runtime
     * 切换语言和字体大小（运行时动态切换）
     * @param language Language code (语言代码)
     * @param font_size Font size (字体大小)
     * @return 0 on success, negative value on failure (0成功，负数失败)
     */
    int mos_font_switch_language(mos_font_language_t language, mos_font_size_t font_size);

    /**
     * @brief Get current language
     * 获取当前语言
     * @return Current language code (当前语言代码)
     */
    mos_font_language_t mos_font_get_current_language(void);

    /**
     * @brief Get current font size
     * 获取当前字体大小
     * @return Current font size (当前字体大小)
     */
    mos_font_size_t mos_font_get_current_size(void);
#endif

#ifdef __cplusplus
}
#endif

#endif /* MOS_FONT_STORAGE_H */
