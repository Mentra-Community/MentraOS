
#ifndef UI_FRAMEWORK_H_
#define UI_FRAMEWORK_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define UI_FRAMEWORK_PAGE_STACK_DEPTH 8U
#define UI_FRAMEWORK_MODAL_STACK_DEPTH 4U
#define UI_FRAMEWORK_OVERLAY_STACK_DEPTH 4U
#define UI_FRAMEWORK_PAGE_STATE_MAX_SIZE 1024U

/*
 * UI framework core types. / UI 框架核心类型。
 *
 * Current project focus is welcome / translation / xy pages and runtime language switch.
 * 当前项目重点是欢迎页、翻译页、XY 页面以及运行时语言切换。
 * Image and map pages are intentionally defined as placeholders for future work.
 * 图像页和地图页当前故意保留为占位定义，供后续功能扩展使用。
 */
typedef enum
{
    UI_PAGE_WELCOME = 0,
    UI_PAGE_CAPTION,  // 通用字幕/文本显示页面 / generic caption page
    UI_PAGE_TEXT_CAPTION = UI_PAGE_CAPTION,  // 为旧调用点保留的兼容别名 / legacy alias kept for older call sites
    UI_PAGE_TRANSLATION,  // 翻译结果页面 / translation-result page
    UI_PAGE_TEXT_XY,  // 文本页面 / text page
    UI_PAGE_TEST_PATTERN,  // 测试页面 / test pattern page
    UI_PAGE_IMAGE_PLACEHOLDER, /* 未来：图像查看页面 / Future: image viewer page */
    UI_PAGE_MAP_PLACEHOLDER, /* 未来：地图/导航页面 / Future: map/navigation page */
    UI_PAGE_COUNT,
} ui_page_type_t;

typedef enum
{
    UI_LANG_UNKNOWN = 0,
    UI_LANG_ZH,
    UI_LANG_EN,
    UI_LANG_KO,
    UI_LANG_JA,
} ui_lang_t;

typedef enum
{
    UI_EVENT_NONE = 0,
    UI_EVENT_BACK,
    UI_EVENT_BUTTON_SHORT,
    UI_EVENT_BUTTON_LONG,
    UI_EVENT_TOUCH_GESTURE,
    UI_EVENT_REFRESH,
    UI_EVENT_CUSTOM,
} ui_event_type_t;

typedef struct
{
    ui_event_type_t type;
    uintptr_t code;
    uintptr_t value;
    const void *data;
    uint16_t data_size;
} ui_event_t;

#ifndef UI_FRAMEWORK_DEFAULT_LANG
#define UI_FRAMEWORK_DEFAULT_LANG UI_LANG_EN
#endif

typedef struct
{
    uintptr_t value;
    const void *data;
    uint16_t data_size;
} ui_page_params_t;

typedef struct
{
    ui_page_type_t page;
    ui_page_params_t params;
} ui_page_stack_entry_t;

typedef struct
{
    ui_page_type_t current_page;  // 当前页面 / current page
    ui_page_type_t previous_page;  // 上一个页面 / previous page
    ui_page_type_t base_page;  // 当前基础页面 / current base page
    ui_page_type_t active_modal;  // UI_PAGE_COUNT 表示没有激活的模态框 / UI_PAGE_COUNT means no active modal
    ui_page_type_t active_overlay;  // UI_PAGE_COUNT 表示没有激活的覆盖层 / UI_PAGE_COUNT means no active overlay
    ui_lang_t current_lang;  // 当前语言 / current language
    uint8_t page_stack_depth;  // 页面栈深度 / page stack depth
    uint8_t modal_depth;  // 模态框深度，弹窗页面 / modal depth, for dialog pages
    uint8_t overlay_depth;  // 覆盖层深度，小窗口 / overlay depth, for small window pages
} ui_framework_state_t;

typedef struct
{
    ui_page_type_t page;
    const char *name;
    bool supported;
    size_t state_size; /* 0 表示没有托管页面状态 / 0 means no managed page state */
    int (*init_state)(void *state, void *context);
    int (*deinit_state)(void *state, void *context);
    int (*show)(void *context);
    int (*hide)(void *context);
    int (*refresh)(void *context);
    int (*destroy)(void *context);
    int (*on_language_changed)(ui_lang_t lang, void *context);
    int (*on_event)(const ui_event_t *event, void *context);
} ui_page_descriptor_t;

/* Initialize UI framework state. Call once during display runtime init. / 初始化 UI
 * 框架状态，在显示运行时初始化阶段调用一次。 */
void ui_framework_init(void);

/* Reset UI framework state to defaults (welcome + en). / 将 UI 框架状态重置为默认值（欢迎页 + 英文）。 */
void ui_framework_reset(void);

/*
 * Deprecated compatibility API (state-only navigation, no lifecycle dispatch).
 * 已弃用的兼容 API（仅状态跳转，不分发生命周期回调）。
 * Keep for legacy callsites only; production paths should use ui_framework_route_to().
 * 仅供旧调用点保留；生产路径应使用 ui_framework_route_to()。
 */
void ui_framework_navigate_to(ui_page_type_t page);

/* Register page lifecycle hooks. Descriptors are copied by value. / 注册页面生命周期钩子，描述符按值拷贝。 */
int ui_framework_register_page(const ui_page_descriptor_t *descriptor);

/* Route to a registered page by replacing the current base page. / 通过替换当前基础页面切换到已注册页面。 */
int ui_framework_route_to(ui_page_type_t page, void *context);
int ui_framework_route_to_with_params(ui_page_type_t page, const ui_page_params_t *params, void *context);

/*
 * Reserved APIs for future navigation stack.
 * 为未来导航栈预留的 API。
 * Current production flow should not depend on push/go_back behavior yet.
 * 当前生产流程暂不应依赖 push/go_back 行为。
 */
int ui_framework_push_page(ui_page_type_t page, const ui_page_params_t *params, void *context);
int ui_framework_replace_page(ui_page_type_t page, const ui_page_params_t *params, void *context);
int ui_framework_go_back(void *context);
bool ui_framework_can_go_back(void);

/* Reserved modal/overlay APIs (not enabled in current production flow). / 为模态框和覆盖层预留的
 * API（当前生产流程未启用）。 */
int ui_framework_present_modal(ui_page_type_t page, const ui_page_params_t *params, void *context);
int ui_framework_dismiss_modal(void *context);
bool ui_framework_has_modal(void);
int ui_framework_show_overlay(ui_page_type_t page, const ui_page_params_t *params, void *context);
int ui_framework_dismiss_overlay(void *context);
bool ui_framework_has_overlay(void);

/* Ask the current page to refresh or react to a runtime language change. / 通知当前页面刷新，或响应运行时语言变化。 */
int ui_framework_refresh_current(void *context);
int ui_framework_notify_language_changed(void *context);
int ui_framework_dispatch_event(const ui_event_t *event, void *context);

/* Inspect registered page metadata. / 查看已注册页面的元数据。 */
const ui_page_descriptor_t *ui_framework_get_page_descriptor(ui_page_type_t page);
void *ui_framework_get_page_state(ui_page_type_t page);
void *ui_framework_get_current_page_state(void);

/* Read current and previous page state. / 读取当前页与上一页状态。 */
ui_page_type_t ui_framework_get_current_page(void);
ui_page_type_t ui_framework_get_previous_page(void);
ui_page_type_t ui_framework_get_base_page(void);
ui_page_type_t ui_framework_get_active_page(void);
uint8_t ui_framework_get_stack_depth(void);
uint8_t ui_framework_get_modal_depth(void);
uint8_t ui_framework_get_overlay_depth(void);
bool ui_framework_get_current_params(ui_page_params_t *out_params);

/* Set/Get app language state for runtime text and font policy. / 设置或获取应用语言状态，用于运行时文本与字体策略。 */
void ui_framework_set_language(ui_lang_t lang);
ui_lang_t ui_framework_get_language(void);

/* Snapshot full state (for diagnostics and future routing policies). / 获取完整状态快照，用于诊断和未来路由策略。 */
void ui_framework_get_state(ui_framework_state_t *out_state);

/* Capability check so future features can gate unavailable placeholder pages cleanly. /
 * 能力检查，便于未来功能优雅地屏蔽不可用的占位页面。 */
bool ui_framework_page_is_supported(ui_page_type_t page);

#endif /* UI_FRAMEWORK_H_ */
