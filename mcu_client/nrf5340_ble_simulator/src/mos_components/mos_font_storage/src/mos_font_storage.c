/*
 * @Author       : Cole
 * @Date         : 2026-02-05 14:53:31
 * @LastEditTime : 2026-02-07 14:59:43
 * @FilePath     : mos_font_storage.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2026
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_font_storage.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "mos_binfont_lvgl.h"

LOG_MODULE_REGISTER(mos_font_storage, LOG_LEVEL_INF);

static bool font_loaded = false;

int mos_font_storage_load(void)
{
    /* Font is now initialized via mos_binfont_lvgl_init().
     * This API is deprecated and kept only for compatibility.
     * 现在通过 mos_binfont_lvgl_init() 初始化字体；该函数已废弃，仅保留兼容。 */
    LOG_WRN("mos_font_storage_load() is deprecated, use mos_binfont_lvgl_init() instead");
    return 0;
}

bool mos_font_storage_is_loaded(void)
{
    /* Font load state is now managed by mos_binfont_lvgl.
     * 字体加载状态现在由 mos_binfont_lvgl 管理。 */
    return font_loaded;
}

void mos_font_storage_unload(void)
{
    /* Font resources are now released via mos_binfont_lvgl_deinit().
     * 字体资源现在通过 mos_binfont_lvgl_deinit() 清理。 */
    font_loaded = false;
}

#if defined(CONFIG_LVGL)

/* Font-switch callback management
 * 字体切换回调管理 */
#define MAX_FONT_CHANGE_CALLBACKS 5

static mos_font_change_callback_t s_font_change_callbacks[MAX_FONT_CHANGE_CALLBACKS] = {0};
static int s_callback_count = 0;

int mos_font_register_change_callback(mos_font_change_callback_t callback)
{
    if (callback == NULL)
    {
        return -EINVAL;
    }

    if (s_callback_count >= MAX_FONT_CHANGE_CALLBACKS)
    {
        LOG_ERR("Font change callback list full");
        return -ENOMEM;
    }

    /* Check whether the callback is already registered.
     * 检查是否已注册。 */
    for (int i = 0; i < s_callback_count; i++)
    {
        if (s_font_change_callbacks[i] == callback)
        {
            LOG_WRN("Font change callback already registered");
            return 0;
        }
    }

    s_font_change_callbacks[s_callback_count++] = callback;
    LOG_INF("Font change callback registered, total: %d", s_callback_count);
    return 0;
}

int mos_font_unregister_change_callback(mos_font_change_callback_t callback)
{
    if (callback == NULL)
    {
        return -EINVAL;
    }

    for (int i = 0; i < s_callback_count; i++)
    {
        if (s_font_change_callbacks[i] == callback)
        {
            /* Remove callback and shift subsequent entries forward.
             * 移除回调并将后续项前移。 */
            for (int j = i; j < s_callback_count - 1; j++)
            {
                s_font_change_callbacks[j] = s_font_change_callbacks[j + 1];
            }
            s_callback_count--;
            LOG_INF("Font change callback unregistered, total: %d", s_callback_count);
            return 0;
        }
    }

    LOG_WRN("Font change callback not found");
    return -ENOENT;
}

static void notify_font_change_callbacks(const lv_font_t *new_font)
{
    LOG_INF("Notifying %d font change callbacks", s_callback_count);
    for (int i = 0; i < s_callback_count; i++)
    {
        if (s_font_change_callbacks[i] != NULL)
        {
            LOG_INF("Calling font change callback %d", i);
            s_font_change_callbacks[i](new_font);
        }
    }
}

const lv_font_t *mos_font_storage_get_lvgl_font(void)
{
    /* Delegate to binfont_lvgl implementation.
     * 委托给 binfont_lvgl 实现。 */
    return mos_binfont_get_lvgl_font();
}

int mos_font_switch_language(uint8_t language, uint8_t font_size)
{
    /* Delegate to binfont_lvgl implementation.
     * 委托给 binfont_lvgl 实现。 */
    int ret = mos_binfont_switch_language(language, font_size);

    if (ret == 0)
    {
        /* Notify all callbacks after successful font switch.
         * 字体切换成功后通知所有回调。 */
        const lv_font_t *new_font = mos_binfont_get_lvgl_font();
        notify_font_change_callbacks(new_font);
    }

    return ret;
}

uint8_t mos_font_get_current_language(void)
{
    return mos_binfont_get_current_language();
}

uint8_t mos_font_get_current_size(void)
{
    return mos_binfont_get_current_size();
}
#endif
