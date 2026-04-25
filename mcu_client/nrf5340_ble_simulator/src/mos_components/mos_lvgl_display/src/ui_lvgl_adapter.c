#include "ui_lvgl_adapter.h"

#include <errno.h>
#include <string.h>
#include <zephyr/sys/util.h>

#include "display_pattern.h"
#include "display_translation_view.h"
#include "display_scene.h"
#include "display_test_view.h"
#include "display_welcome_view.h"
#include "display_xy_view.h"
#include "translation_state.h"
#include "ui_framework.h"
#include "ui_pages.h"

static ui_lvgl_adapter_hooks_t s_hooks;

static display_scene_mode_t ui_pages_scene_mode_from_pattern(display_pattern_id_t pattern_id)
{
    switch (pattern_id)
    {
        case DISPLAY_PATTERN_TEXT_CONTAINER:
            return DISPLAY_SCENE_MODE_WELCOME;
        case DISPLAY_PATTERN_XY_TEXT:
            return DISPLAY_SCENE_MODE_XY;
        case DISPLAY_PATTERN_CHESS:
        case DISPLAY_PATTERN_HORIZONTAL_ZEBRA:
        case DISPLAY_PATTERN_VERTICAL_ZEBRA:
        case DISPLAY_PATTERN_SCROLLING_WELCOME:
        case DISPLAY_PATTERN_COUNT:
        default:
            return DISPLAY_SCENE_MODE_TEST;
    }
}

static lv_obj_t *ui_lvgl_adapter_screen(void *context)
{
    ui_lvgl_page_context_t *page_context = (ui_lvgl_page_context_t *)context;

    if (page_context != NULL && page_context->screen != NULL)
    {
        return page_context->screen;
    }

    return lv_screen_active();
}

static int ui_lvgl_page_show_welcome(void *context)
{
    lv_obj_t *screen = ui_lvgl_adapter_screen(context);

    display_translation_view_destroy();
    if (s_hooks.prepare_welcome != NULL)
    {
        s_hooks.prepare_welcome(screen);
    }
    else
    {
        display_welcome_view_ensure(screen);
    }
    display_welcome_view_restore(screen);
    return 0;
}

static int ui_lvgl_page_show_translation(void *context)
{
    lv_obj_t *screen = ui_lvgl_adapter_screen(context);

    display_translation_view_ensure(screen, display_welcome_view_get_container());
    return 0;
}

static int ui_lvgl_page_show_xy(void *context)
{
    lv_obj_t *screen = ui_lvgl_adapter_screen(context);

    display_xy_view_ensure(screen);
    return 0;
}

static int ui_lvgl_page_show_test(void *context)
{
    ui_lvgl_page_context_t *page_context = (ui_lvgl_page_context_t *)context;
    lv_obj_t *screen = ui_lvgl_adapter_screen(context);
    display_pattern_id_t pattern_id =
        (page_context != NULL) ? page_context->pattern_id : display_test_view_get_current_pattern();

    display_test_view_show_pattern(screen, pattern_id);
    return 0;
}

static int ui_lvgl_page_hide_welcome(void *context)
{
    ARG_UNUSED(context);
    display_welcome_view_set_active(false);
    return 0;
}

static int ui_lvgl_page_refresh_welcome(void *context)
{
    ARG_UNUSED(context);
    display_welcome_view_reset_text_cache();
    if (s_hooks.refresh_welcome != NULL)
    {
        s_hooks.refresh_welcome();
    }
    return 0;
}

static int ui_lvgl_page_refresh_translation(void *context)
{
    char last_text[TRANSLATION_TEXT_MAX_CHARS];

    ARG_UNUSED(context);

    if (!display_translation_view_has_last_text())
    {
        display_translation_view_invalidate_visible();
        return 0;
    }

    strncpy(last_text, display_translation_view_get_last_text(), sizeof(last_text) - 1U);
    last_text[sizeof(last_text) - 1U] = '\0';
    display_translation_view_invalidate_last_text();

    if (s_hooks.render_translation != NULL)
    {
        s_hooks.render_translation(last_text, 0U);
    }
    return 0;
}

static int ui_lvgl_page_refresh_xy(void *context)
{
    ARG_UNUSED(context);
    display_xy_view_invalidate_visible();
    return 0;
}

static int ui_lvgl_page_on_language_changed(ui_lang_t lang, void *context)
{
    ARG_UNUSED(lang);
    return ui_framework_refresh_current(context);
}

int ui_pages_register_display_pages(const ui_page_lifecycle_t *lifecycle)
{
    if (lifecycle == NULL)
    {
        return -EINVAL;
    }

    /*
     * CAPTION and TRANSLATION are intentionally registered as different pages
     * even though they currently reuse the same low-level text view.
     * That keeps business meaning separate now, while leaving room for future
     * layout divergence without reworking the whole page framework.
     * CAPTION 和 TRANSLATION 故意注册成两个不同页面，
     * 即使它们当前仍共用同一套底层文本视图实现。
     * 这样可以先把业务语义拆清楚，同时给后续拆分不同布局留好位置。
     */
    const ui_page_descriptor_t descriptors[UI_PAGE_COUNT] = {
        [UI_PAGE_WELCOME] =
            {
                .page = UI_PAGE_WELCOME,
                .name = ui_pages_name(UI_PAGE_WELCOME),
                .supported = true,
                .state_size = display_welcome_view_state_size(),
                .init_state = display_welcome_view_state_init,
                .deinit_state = display_welcome_view_state_deinit,
                .show = lifecycle->show_welcome,
                .hide = lifecycle->hide_welcome,
                .refresh = lifecycle->refresh_welcome,
                .on_language_changed = lifecycle->on_language_changed,
            },
        [UI_PAGE_CAPTION] =
            {
                .page = UI_PAGE_CAPTION,
                .name = ui_pages_name(UI_PAGE_CAPTION),
                .supported = true,
                .show = lifecycle->show_translation,
                .refresh = lifecycle->refresh_translation,
                .on_language_changed = lifecycle->on_language_changed,
            },
        [UI_PAGE_TRANSLATION] =
            {
                .page = UI_PAGE_TRANSLATION,
                .name = ui_pages_name(UI_PAGE_TRANSLATION),
                .supported = true,
                .state_size = display_translation_view_state_size(),
                .init_state = display_translation_view_state_init,
                .deinit_state = display_translation_view_state_deinit,
                .show = lifecycle->show_translation,
                .refresh = lifecycle->refresh_translation,
                .on_language_changed = lifecycle->on_language_changed,
            },
        [UI_PAGE_TEXT_XY] =
            {
                .page = UI_PAGE_TEXT_XY,
                .name = ui_pages_name(UI_PAGE_TEXT_XY),
                .supported = true,
                .state_size = display_xy_view_state_size(),
                .init_state = display_xy_view_state_init,
                .deinit_state = display_xy_view_state_deinit,
                .show = lifecycle->show_xy,
                .refresh = lifecycle->refresh_xy,
                .on_language_changed = lifecycle->on_language_changed,
            },
        [UI_PAGE_TEST_PATTERN] =
            {
                .page = UI_PAGE_TEST_PATTERN,
                .name = ui_pages_name(UI_PAGE_TEST_PATTERN),
                .supported = true,
                .state_size = display_test_view_state_size(),
                .init_state = display_test_view_state_init,
                .deinit_state = display_test_view_state_deinit,
                .show = lifecycle->show_test,
            },
        [UI_PAGE_IMAGE_PLACEHOLDER] =
            {
                .page = UI_PAGE_IMAGE_PLACEHOLDER,
                .name = ui_pages_name(UI_PAGE_IMAGE_PLACEHOLDER),
                .supported = false,
            },
        [UI_PAGE_MAP_PLACEHOLDER] =
            {
                .page = UI_PAGE_MAP_PLACEHOLDER,
                .name = ui_pages_name(UI_PAGE_MAP_PLACEHOLDER),
                .supported = false,
            },
    };

    for (size_t index = 0U; index < ARRAY_SIZE(descriptors); ++index)
    {
        int ret = ui_framework_register_page(&descriptors[index]);
        if (ret != 0)
        {
            return ret;
        }
    }

    return 0;
}

ui_page_type_t ui_pages_from_pattern(display_pattern_id_t pattern_id)
{
    switch (pattern_id)
    {
        case DISPLAY_PATTERN_TEXT_CONTAINER:
            return UI_PAGE_WELCOME;
        case DISPLAY_PATTERN_XY_TEXT:
            return UI_PAGE_TEXT_XY;
        case DISPLAY_PATTERN_CHESS:
        case DISPLAY_PATTERN_HORIZONTAL_ZEBRA:
        case DISPLAY_PATTERN_VERTICAL_ZEBRA:
        case DISPLAY_PATTERN_SCROLLING_WELCOME:
        default:
            return UI_PAGE_TEST_PATTERN;
    }
}

display_pattern_id_t ui_pages_default_pattern_for_page(ui_page_type_t page)
{
    switch (page)
    {
        case UI_PAGE_TEXT_XY:
            return DISPLAY_PATTERN_XY_TEXT;
        case UI_PAGE_WELCOME:
        case UI_PAGE_CAPTION:
        case UI_PAGE_TRANSLATION:
            return DISPLAY_PATTERN_TEXT_CONTAINER;
        case UI_PAGE_TEST_PATTERN:
            return DISPLAY_PATTERN_CHESS;
        case UI_PAGE_IMAGE_PLACEHOLDER:
        case UI_PAGE_MAP_PLACEHOLDER:
        case UI_PAGE_COUNT:
        default:
            return DISPLAY_PATTERN_DEFAULT;
    }
}

static display_scene_mode_t ui_pages_scene_mode_for_page(ui_page_type_t page)
{
    switch (page)
    {
        case UI_PAGE_WELCOME:
            return DISPLAY_SCENE_MODE_WELCOME;
        case UI_PAGE_CAPTION:
        case UI_PAGE_TRANSLATION:
            return DISPLAY_SCENE_MODE_TRANSLATION;
        case UI_PAGE_TEXT_XY:
            return DISPLAY_SCENE_MODE_XY;
        case UI_PAGE_TEST_PATTERN:
        case UI_PAGE_IMAGE_PLACEHOLDER:
        case UI_PAGE_MAP_PLACEHOLDER:
        case UI_PAGE_COUNT:
        default:
            return DISPLAY_SCENE_MODE_TEST;
    }
}

int ui_pages_apply_page_scene(ui_page_type_t page)
{
    display_pattern_id_t pattern_id = ui_pages_default_pattern_for_page(page);
    display_scene_mode_t scene_mode = ui_pages_scene_mode_for_page(page);

    if (!display_pattern_id_is_valid((int)pattern_id))
    {
        return -EINVAL;
    }

    display_scene_set_pattern(pattern_id);
    display_scene_set_mode(scene_mode);
    return 0;
}

int ui_pages_apply_test_pattern_scene(display_pattern_id_t pattern_id)
{
    if (!display_pattern_id_is_valid((int)pattern_id))
    {
        return -EINVAL;
    }

    display_scene_set_pattern(pattern_id);
    display_scene_set_mode(ui_pages_scene_mode_from_pattern(pattern_id));
    return 0;
}

void ui_pages_mark_test_context(void)
{
    display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
}

const char *ui_pages_name(ui_page_type_t page)
{
    switch (page)
    {
        case UI_PAGE_WELCOME:
            return "welcome";
        case UI_PAGE_CAPTION:
            return "caption";
        case UI_PAGE_TRANSLATION:
            return "translation";
        case UI_PAGE_TEXT_XY:
            return "xy";
        case UI_PAGE_TEST_PATTERN:
            return "test";
        case UI_PAGE_IMAGE_PLACEHOLDER:
            return "image";
        case UI_PAGE_MAP_PLACEHOLDER:
            return "map";
        case UI_PAGE_COUNT:
        default:
            return "unknown";
    }
}

int ui_lvgl_adapter_register_pages(const ui_lvgl_adapter_hooks_t *hooks)
{
    if (hooks == NULL)
    {
        return -EINVAL;
    }

    s_hooks = *hooks;// 赋值给全局变量

    const ui_page_lifecycle_t lifecycle = {
        .show_welcome = ui_lvgl_page_show_welcome,
        .hide_welcome = ui_lvgl_page_hide_welcome,
        .refresh_welcome = ui_lvgl_page_refresh_welcome,
        .show_translation = ui_lvgl_page_show_translation,
        .refresh_translation = ui_lvgl_page_refresh_translation,
        .show_xy = ui_lvgl_page_show_xy,
        .refresh_xy = ui_lvgl_page_refresh_xy,
        .show_test = ui_lvgl_page_show_test,
        .on_language_changed = ui_lvgl_page_on_language_changed,
    };

    return ui_pages_register_display_pages(&lifecycle);
}
