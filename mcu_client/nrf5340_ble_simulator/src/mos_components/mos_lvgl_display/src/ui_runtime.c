#include "ui_runtime.h"

#include <errno.h>

#include "display_test_view.h"
#include "ui_pages.h"

/*
 * ui_runtime is the thin "business-facing" runtime layer.
 *
 * It sits above ui_framework and below thread-safe public display APIs:
 * - ui_framework owns page stack state and lifecycle dispatch
 * - ui_runtime chooses which page/pattern to show for a given business action
 * - public display_* APIs enqueue work into the LVGL thread before reaching here
 * ui_runtime 是面向业务语义的一层薄运行时封装。
 *
 * 它位于 ui_framework 之上、线程安全 display_* 公共接口之下：
 * - ui_framework 负责页面栈状态和生命周期分发
 * - ui_runtime 负责把业务动作映射到页面/图案
 * - 外部 display_* 接口先把任务入队到 LVGL 线程，再进入这里
 */
static int ui_runtime_apply_page_scene(ui_page_type_t page)
{
    return ui_pages_apply_page_scene(page);
}

int ui_runtime_show_page(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    int ret = ui_framework_route_to_with_params(page, params, context);

    if (ret != 0)
    {
        return ret;
    }

    return ui_runtime_apply_page_scene(page);
}

int ui_runtime_show_welcome(void *context)
{
    return ui_runtime_show_page(UI_PAGE_WELCOME, NULL, context);
}

int ui_runtime_show_caption(const ui_page_params_t *params, void *context)
{
    return ui_runtime_show_page(UI_PAGE_CAPTION, params, context);
}

int ui_runtime_show_translation(const ui_page_params_t *params, void *context)
{
    return ui_runtime_show_page(UI_PAGE_TRANSLATION, params, context);
}

int ui_runtime_show_xy(const ui_page_params_t *params, void *context)
{
    return ui_runtime_show_page(UI_PAGE_TEXT_XY, params, context);
}

int ui_runtime_push_page(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    int ret = ui_framework_push_page(page, params, context);

    if (ret != 0)
    {
        return ret;
    }

    return ui_runtime_apply_page_scene(page);
}

int ui_runtime_replace_page(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    int ret = ui_framework_replace_page(page, params, context);

    if (ret != 0)
    {
        return ret;
    }

    return ui_runtime_apply_page_scene(page);
}

int ui_runtime_show_pattern(display_pattern_id_t pattern_id, void *context)
{
    ui_page_type_t page;
    int ret;

    if (!display_pattern_id_is_valid((int)pattern_id))
    {
        return -EINVAL;
    }

    /* Pattern routing is mainly for test/bring-up flows.
     * The page is derived from the shell-visible pattern id.
     * pattern 路由主要服务测试/点亮流程。
     * 页面类型由 shell 可见的 pattern id 派生得到。
     */
    page = ui_pages_from_pattern(pattern_id);
    ret = ui_framework_route_to(page, context);
    if (ret != 0)
    {
        return ret;
    }

    return ui_pages_apply_test_pattern_scene(pattern_id);
}

int ui_runtime_show_test_pattern(display_pattern_id_t pattern_id, void *context)
{
    int ret = ui_runtime_show_pattern(pattern_id, context);

    if (ret != 0)
    {
        return ret;
    }

    display_test_view_set_current_pattern(pattern_id);
    return 0;
}

int ui_runtime_go_back(void *context)
{
    return ui_framework_go_back(context);
}

int ui_runtime_refresh(void *context)
{
    return ui_framework_refresh_current(context);
}

int ui_runtime_dispatch_event(const ui_event_t *event, void *context)
{
    return ui_framework_dispatch_event(event, context);
}

bool ui_runtime_page_is_active(ui_page_type_t page)
{
    return ui_framework_get_active_page() == page;
}

bool ui_runtime_translation_render_is_allowed(void)
{
    /*
     * The low-level text pipeline is shared by caption/translation pages.
     * Rendering is allowed only when the active page is one of those text-capable pages.
     * 底层文本流水线由 caption/translation 页面共用。
     * 只有当前活动页是这些文本页面之一时，才允许真正提交渲染。
     */
    return ui_runtime_page_is_active(UI_PAGE_WELCOME) || ui_runtime_page_is_active(UI_PAGE_CAPTION)
        || ui_runtime_page_is_active(UI_PAGE_TRANSLATION);
}

display_pattern_id_t ui_runtime_current_pattern(void)
{
    ui_page_type_t page = ui_framework_get_active_page();

    /*
     * Business pages use their default pattern mapping.
     * Test pages keep their own explicit current pattern state.
     * 业务页面直接使用各自默认 pattern 映射。
     * 测试页面则保留自己显式设置的当前 pattern 状态。
     */
    if (page == UI_PAGE_TEST_PATTERN)
    {
        return display_test_view_get_current_pattern();
    }

    return ui_pages_default_pattern_for_page(page);
}

void ui_runtime_mark_test_context(void)
{
    ui_pages_mark_test_context();
}
