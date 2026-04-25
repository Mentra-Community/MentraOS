#ifndef _MOS_LVGL_DISPLAY_H_
#define _MOS_LVGL_DISPLAY_H_

#include <lvgl.h>

#include "display_pattern.h"
#include "ui_framework.h"
// #include "mentraos_ble.pb.h"
typedef enum
{
    LCD_STATE_INIT = 0,
    LCD_STATE_OFF,
    LCD_STATE_ON,
} display_state_t;

typedef enum
{
    DISPLAY_BIZ_LANG_UNKNOWN = 0,
    DISPLAY_BIZ_LANG_ZH = 1,
    DISPLAY_BIZ_LANG_EN = 2,
    DISPLAY_BIZ_LANG_KO = 3,
    DISPLAY_BIZ_LANG_JA = 4,
} display_biz_lang_t;

#ifndef DISPLAY_DEFAULT_TRANSLATION_SRC_LANG
#define DISPLAY_DEFAULT_TRANSLATION_SRC_LANG DISPLAY_BIZ_LANG_EN
#endif

#ifndef DISPLAY_DEFAULT_TRANSLATION_DST_LANG
#define DISPLAY_DEFAULT_TRANSLATION_DST_LANG DISPLAY_BIZ_LANG_ZH
#endif

/* Display command types pushed into the LVGL thread message queue. / 发送到 LVGL 线程消息队列的显示命令类型。 */
typedef enum
{
    LCD_CMD_INIT,
    LCD_CMD_OPEN,
    LCD_CMD_CLOSE,
    LCD_CMD_TEXT,
    LCD_CMD_DATA,
    LCD_CMD_CYCLE_PATTERN,  // Cycle test patterns / 循环测试图案
    LCD_CMD_UPDATE_PROTOBUF_TEXT,  // Update generic protobuf text flow / 更新通用 protobuf 文本流
    LCD_CMD_UPDATE_XY_TEXT,  // Update XY positioned text / 更新 XY 定位文本
    LCD_CMD_GBK_TEST,  // Show simple GBK test text / 显示简单 GBK 测试文本
    LCD_CMD_GBK_CHARS_TEST,  // Show per-character GBK test / 显示逐字 GBK 测试
    LCD_CMD_UPDATE_WELCOME_BATTERY,  // Refresh battery line on welcome screen / 刷新欢迎页电量行
    LCD_CMD_SHOW_WELCOME_SCREEN,  // Switch to welcome page / 切到欢迎页
    LCD_CMD_SHOW_CAPTION_SCREEN,  // Switch to generic caption page / 切到通用字幕页
    LCD_CMD_SHOW_TRANSLATION_SCREEN,  // Switch to translation page / 切到翻译页
    LCD_CMD_UPDATE_DFU_PROGRESS,  // Update DFU progress on welcome screen / 更新欢迎页 DFU 进度
    LCD_CMD_UPDATE_DFU_STATUS_TEXT,  // Update DFU status line / 更新 DFU 状态文本
    LCD_CMD_GRAYSCALE_HORIZONTAL,  // Draw horizontal grayscale pattern / 绘制横向灰阶图案
    LCD_CMD_GRAYSCALE_VERTICAL,  // Draw vertical grayscale pattern / 绘制纵向灰阶图案
    LCD_CMD_CHESS_PATTERN,  // Draw chess pattern / 绘制棋盘图案
    LCD_CMD_SHOW_PATTERN,  // Show a specific test pattern / 显示指定测试图案
    LCD_CMD_CLEAR_DISPLAY,  // Clear current display content / 清空当前显示内容
    LCD_CMD_INVALIDATE_FULL_SCREEN, /* Mark full screen dirty and request one refresh. / 标记整屏脏区并请求一次刷新。 */
    LCD_CMD_INVALIDATE_VISIBLE_UI, /* Mark only visible UI roots dirty. / 仅标记当前可见 UI 根节点为脏区。 */
    LCD_CMD_UPDATE_HEIGHT,
    LCD_CMD_NOTIFY_LANGUAGE_CHANGED,
    LCD_CMD_UI_EVENT,
    LCD_CMD_UPDATE_DYNAMIC_FONT  // Apply dynamic font change in LVGL thread / 在 LVGL 线程应用动态字体切换
} display_cmd_type_t;

/* Display on/off control helpers. / 显示开关控制辅助函数。 */
void set_display_onoff(bool state);
bool get_display_onoff(void);

#define MAX_TEXT_LEN 247
typedef struct
{
    char text[MAX_TEXT_LEN + 1];
    int16_t x;
    int16_t y;
    uint16_t font_code;
    uint32_t font_color;
    uint8_t size;
} lcd_text_param_t;

typedef struct
{
    uint8_t brightness;
    uint8_t mirror;
} lcd_open_param_t;

typedef struct
{
    display_pattern_id_t pattern_id;  // Shell-visible diagnostic pattern ID / Shell 可见的诊断图案 ID
} lcd_pattern_param_t;

typedef struct
{
    uint8_t show;  // 1 = show and update, 0 = hide / 1=显示并更新，0=隐藏
    uint8_t percent;  // 0..100 progress / 0..100 进度
} lcd_dfu_progress_param_t;

typedef struct
{
    char text[MAX_TEXT_LEN + 1];  // Generic protobuf text payload / 通用 protobuf 文本载荷
} lcd_protobuf_text_param_t;

typedef struct
{
    uint16_t x;  // X coordinate / X 坐标
    uint16_t y;  // Y coordinate / Y 坐标
    uint16_t font_size;  // Font size / 字号
    uint32_t color;  // Text color / 文字颜色
    char text[MAX_TEXT_LEN + 1];  // XY positioned text content / XY 定位文本内容
} lcd_xy_text_param_t;

typedef struct
{
    uint16_t height;
} lcd_height_param_t;

typedef struct
{
    const lv_font_t *font_ptr;
} lcd_font_update_param_t;

typedef struct
{
    ui_event_t event;
} lcd_ui_event_param_t;

typedef union
{
    lcd_text_param_t text;
    lcd_open_param_t open;
    lcd_pattern_param_t pattern;  // Test pattern parameter / 测试图案参数
    lcd_protobuf_text_param_t protobuf_text;  // Generic protobuf text parameter / 通用 protobuf 文本参数
    lcd_xy_text_param_t xy_text;  // XY positioned text parameter / XY 定位文本参数
    lcd_dfu_progress_param_t dfu_progress;  // DFU progress parameter / DFU 进度参数
    lcd_height_param_t height;
    lcd_font_update_param_t font_update;
    lcd_ui_event_param_t ui_event;
    // Additional command parameter structs can be added here. / 其他命令参数结构体可继续扩展。
} display_param_u;

typedef struct
{
    display_cmd_type_t type;
    display_param_u p;
} display_cmd_t;

void scroll_text_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y, lv_coord_t w, lv_coord_t h, const char *txt,
                        const lv_font_t *font, uint32_t time_ms);

void scroll_text_stop(void);

void display_open(void);

int display_set_translation_pair(display_biz_lang_t src_lang, display_biz_lang_t dst_lang);
void display_get_translation_pair(display_biz_lang_t *src_lang, display_biz_lang_t *dst_lang);

/* Thread-safe test-pattern helpers. / 线程安全的测试图案辅助接口。 */
void display_cycle_pattern(void);
void display_show_test_pattern(display_pattern_id_t pattern_id);

/* Thread-safe GBK test rendering helpers. / 线程安全的 GBK 测试渲染接口。 */
void display_show_gbk_test(void);
void display_show_gbk_chars_test(void);

void display_update_height(uint16_t height);

/* Thread-safe translation text update function. */
void display_update_translation_text(const char *text_content);

/*
 * Thread-safe generic protobuf/display-text update function.
 *
 * Protobuf is the transport/input channel and is not conceptually limited to
 * the translation page. In the current production flow, this generic input is
 * routed to the caption page.
 */
void display_update_protobuf_text(const char *text_content);

/* Route a generic text payload to the active text-display flow.
 * 在当前文本显示流程中路由一段通用文本载荷。
 * In caption/translation/welcome flow it updates text rendering state.
 * 在 caption/translation/welcome 路径中，它会更新文本渲染状态。
 * In XY flow it renders positioned text directly.
 * 在 XY 路径中，它会直接渲染定位文本。
 */
void display_submit_text_payload(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color);

/* Route scrolling text payload to the generic caption flow.
 * 将滚动文本载荷路由到通用字幕显示流程。
 */
void display_submit_scrolling_text_payload(const char *text_content);

/* Direct A6N pattern helpers. / 直接控制 A6N 图案的辅助接口。 */
void display_draw_horizontal_grayscale(void);
void display_draw_vertical_grayscale(void);
void display_draw_chess_pattern(void);

/* XY text positioning entry. / XY 文本定位入口。 */
void display_update_xy_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color);

/* Clear current display content. / 清空当前显示内容。 */
void display_clear_screen(void);

/** After driver-only changes (e.g. software depth), force LVGL to flush the whole screen. Thread-safe. */
void display_request_full_redraw(void);

/** Mark dirty only the UI roots for the current pattern (less tearing than full screen). Thread-safe. */
void display_request_visible_redraw(void);

/** Submit a UI event to the LVGL thread, then dispatch it to the active UI page. */
void display_submit_ui_event(const ui_event_t *event);

/* Get current effective pattern id. / 获取当前生效的 pattern ID。 */
int display_get_current_pattern(void);

/* Snapshot whether the active UI page is still welcome and the shared view is visible. */
bool display_is_welcome_screen_active(void);

void display_close(void);

/** Request welcome screen to refresh battery line (no-op if welcome not active). Call after battery update. */
void display_request_welcome_battery_refresh(void);

/** Return to welcome screen (e.g. after BLE disconnect). Thread-safe, sends command to LVGL. */
void display_show_welcome_screen(void);

/** Show generic caption screen explicitly. Useful for direct text display modes. */
void display_show_caption_screen(void);

/** Show translation screen explicitly. */
void display_show_translation_screen(void);

/** Reset translation text de-dup/pending state so the next identical text can redraw. Thread-safe. */
void display_reset_translation_text_state(void);

/** Reset generic protobuf/display-text pending state. Current production flow shares this state with translation. */
void display_reset_protobuf_text_state(void);

/** Update DFU progress bar on welcome screen (below battery). show=1 to show and set percent (0..100), show=0 to hide.
 * Thread-safe. */
void display_update_dfu_progress(uint8_t show, uint8_t percent);

/** Update DFU status text line below battery (e.g. "DFU Updating... 45% (120 KB)"). text=NULL or "" to hide.
 * Thread-safe. */
void display_update_dfu_status_text(const char *text);

void display_send_frame(void *data_ptr);

// void handle_display_text(const mentraos_ble_DisplayText *txt);
void lvgl_display_thread(void);
void cycle_test_pattern(void);  // Cycle through test patterns
#endif  // !_MOS_LVGL_DISPLAY_H_
