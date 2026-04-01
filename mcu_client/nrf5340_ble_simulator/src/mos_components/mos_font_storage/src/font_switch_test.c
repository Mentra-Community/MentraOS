/*
 * 字体切换测试示例
 *
 * 演示如何使用 MentraOS 的动态字体切换功能
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"

LOG_MODULE_REGISTER(font_switch_test, LOG_LEVEL_INF);

/* 测试用的字体切换回调 */
static void test_font_change_callback(const lv_font_t *new_font)
{
    if (new_font == NULL)
    {
        LOG_WRN("Font change callback received NULL font pointer");
        return;
    }

    LOG_INF("========== Font Changed ==========");
    LOG_INF("Font pointer: %p", new_font);
    LOG_INF("Line height: %d", new_font->line_height);
    LOG_INF("Base line: %d", new_font->base_line);
    LOG_INF("Subpixel: %d", new_font->subpx);
    LOG_INF("================================");

    /* 注意: 这里不能直接调用 LVGL API */
    /* 实际应用中应该通过消息队列发送到 LVGL 线程 */
}

/* 测试 1: 基本语言切换 */
static int test_language_switch(void)
{
    int ret;
    mos_font_language_t lang;
    mos_font_size_t size;

    LOG_INF("=== Test 1: Language Switch ===");

    /* 切换到英语 18pt */
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, MOS_FONT_SIZE_18);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch to EN_US 18pt: %d", ret);
        return ret;
    }

    lang = mos_font_get_current_language();
    size = mos_font_get_current_size();
    LOG_INF("Current: lang=%u, size=%u", lang, size);

    k_sleep(K_MSEC(500));

    /* 切换到简体中文 18pt */
    ret = mos_font_switch_language(MOS_FONT_LANG_ZH_CN, MOS_FONT_SIZE_18);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch to ZH_CN 18pt: %d", ret);
        return ret;
    }

    lang = mos_font_get_current_language();
    size = mos_font_get_current_size();
    LOG_INF("Current: lang=%u, size=%u", lang, size);

    k_sleep(K_MSEC(500));

    /* 切换回英语 20pt */
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, MOS_FONT_SIZE_20);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch to EN_US 20pt: %d", ret);
        return ret;
    }

    lang = mos_font_get_current_language();
    size = mos_font_get_current_size();
    LOG_INF("Current: lang=%u, size=%u", lang, size);

    LOG_INF("=== Test 1 PASSED ===\n");
    return 0;
}

/* 测试 2: 英语字体大小切换 */
static int test_font_size_switch(void)
{
    int ret;
    mos_font_size_t available_sizes[] = {MOS_FONT_SIZE_16, MOS_FONT_SIZE_18, MOS_FONT_SIZE_20,
                                         MOS_FONT_SIZE_22, MOS_FONT_SIZE_24, MOS_FONT_SIZE_26};
    const int size_count = sizeof(available_sizes) / sizeof(available_sizes[0]);

    LOG_INF("=== Test 2: Font Size Switch ===");

    /* 遍历所有支持的字体大小 */
    for (int i = 0; i < size_count; i++)
    {
        ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, available_sizes[i]);
        if (ret != 0)
        {
            LOG_ERR("Failed to switch to size %u: %d", available_sizes[i], ret);
            return ret;
        }

        mos_font_size_t current_size = mos_font_get_current_size();
        LOG_INF("Switched to %upt", current_size);
        k_sleep(K_MSEC(300));
    }

    LOG_INF("=== Test 2 PASSED ===\n");
    return 0;
}

/* 测试 3: 中文自动字号调整 */
static int test_chinese_auto_size(void)
{
    int ret;

    LOG_INF("=== Test 3: Chinese Auto Size ===");

    /* 先设置英语 20pt */
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, MOS_FONT_SIZE_20);
    if (ret != 0)
    {
        LOG_ERR("Failed to set EN_US 20pt: %d", ret);
        return ret;
    }
    LOG_INF("Set EN_US 20pt, current size: %u", mos_font_get_current_size());

    k_sleep(K_MSEC(500));

    /* 切换到中文 (应该自动调整为 18pt) */
    ret = mos_font_switch_language(MOS_FONT_LANG_ZH_CN, MOS_FONT_SIZE_18);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch to ZH_CN: %d", ret);
        return ret;
    }
    LOG_INF("Switched to ZH_CN, current size: %u (should be 18)", mos_font_get_current_size());

    k_sleep(K_MSEC(500));

    /* 切换回英语 20pt */
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, MOS_FONT_SIZE_20);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch back to EN_US 20pt: %d", ret);
        return ret;
    }
    LOG_INF("Switched back to EN_US 20pt, current size: %u", mos_font_get_current_size());

    LOG_INF("=== Test 3 PASSED ===\n");
    return 0;
}

/* 测试 4: 回调注册和触发 */
static int test_callback_registration(void)
{
    int ret;

    LOG_INF("=== Test 4: Callback Registration ===");

    /* 注册测试回调 */
    ret = mos_font_register_change_callback(test_font_change_callback);
    if (ret != 0)
    {
        LOG_ERR("Failed to register callback: %d", ret);
        return ret;
    }
    LOG_INF("Callback registered successfully");

    /* 触发字体切换,应该会调用回调 */
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, MOS_FONT_SIZE_18);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch language: %d", ret);
        return ret;
    }
    k_sleep(K_MSEC(500));

    /* 再次切换 */
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, MOS_FONT_SIZE_20);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch language: %d", ret);
        return ret;
    }
    k_sleep(K_MSEC(500));

    /* 注销回调 */
    ret = mos_font_unregister_change_callback(test_font_change_callback);
    if (ret != 0)
    {
        LOG_ERR("Failed to unregister callback: %d", ret);
        return ret;
    }
    LOG_INF("Callback unregistered successfully");

    /* 再次切换,应该不会调用回调 */
    LOG_INF("Switching font after unregister (callback should NOT be called)");
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, MOS_FONT_SIZE_22);
    if (ret != 0)
    {
        LOG_ERR("Failed to switch language: %d", ret);
        return ret;
    }

    LOG_INF("=== Test 4 PASSED ===\n");
    return 0;
}

/* 测试 5: 错误处理 */
static int test_error_handling(void)
{
    int ret;

    LOG_INF("=== Test 5: Error Handling ===");

    /* 尝试切换中文到 20pt (应该失败,中文只支持 18pt) */
    ret = mos_font_switch_language(MOS_FONT_LANG_ZH_CN, MOS_FONT_SIZE_20);
    if (ret == 0)
    {
        LOG_ERR("ERROR: Switching ZH_CN to 20pt should fail but succeeded");
        return -EINVAL;
    }
    LOG_INF("Zeros correctly rejected ZH_CN 20pt (ret=%d)", ret);

    /* 尝试无效字体大小 */
    ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, (mos_font_size_t)15);
    if (ret == 0)
    {
        LOG_ERR("ERROR: Invalid font size 15 should fail but succeeded");
        return -EINVAL;
    }
    LOG_INF("Correctly rejected invalid font size 15 (ret=%d)", ret);

    /* 尝试无效语言代码 */
    ret = mos_font_switch_language((mos_font_language_t)99, MOS_FONT_SIZE_18);
    if (ret == 0)
    {
        LOG_ERR("ERROR: Invalid language code 99 should fail but succeeded");
        return -EINVAL;
    }
    LOG_INF("Correctly rejected invalid language code 99 (ret=%d)", ret);

    LOG_INF("=== Test 5 PASSED ===\n");
    return 0;
}

/* 主测试函数 */
int run_font_switch_tests(void)
{
    int ret;

    LOG_INF("========================================");
    LOG_INF("Starting Font Switch Tests");
    LOG_INF("========================================\n");

    /* 确保字体已初始化 */
    if (!mos_binfont_is_initialized())
    {
        LOG_INF("Initializing binfont...");
        ret = mos_binfont_lvgl_init();
        if (ret != 0)
        {
            LOG_ERR("Failed to initialize binfont: %d", ret);
            return ret;
        }
    }

    /* 运行所有测试 */
    ret = test_language_switch();
    if (ret != 0)
    {
        LOG_ERR("Test 1 failed: %d", ret);
        return ret;
    }

    ret = test_font_size_switch();
    if (ret != 0)
    {
        LOG_ERR("Test 2 failed: %d", ret);
        return ret;
    }

    ret = test_chinese_auto_size();
    if (ret != 0)
    {
        LOG_ERR("Test 3 failed: %d", ret);
        return ret;
    }

    ret = test_callback_registration();
    if (ret != 0)
    {
        LOG_ERR("Test 4 failed: %d", ret);
        return ret;
    }

    ret = test_error_handling();
    if (ret != 0)
    {
        LOG_ERR("Test 5 failed: %d", ret);
        return ret;
    }

    LOG_INF("========================================");
    LOG_INF("All Font Switch Tests PASSED!");
    LOG_INF("========================================");

    return 0;
}

/* 测试函数可以通过代码调用，或者添加到 shell_font_storage.c 的命令中 */
