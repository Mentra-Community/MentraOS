#ifndef _MOS_LVGL_DISPLAY_H_
#define _MOS_LVGL_DISPLAY_H_

#include <lvgl.h>
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

/* 消息队列的命令类型 */
typedef enum
{
    LCD_CMD_OPEN,
    LCD_CMD_CLOSE,
    LCD_CMD_UPDATE_PROTOBUF_TEXT,    // **NEW: Update container with protobuf text**
    LCD_CMD_UPDATE_POSITIONED_TEXT,  // Render text at an absolute (x,y) position on the caption overlay
    LCD_CMD_UPDATE_WELCOME_BATTERY,  // **NEW: Refresh welcome label with current battery (60s period)**
    LCD_CMD_BT_DISCONNECTED,          // BLE disconnect event — handler decides the UI response
    LCD_CMD_UPDATE_DFU_PROGRESS,      // **NEW: Show/update DFU progress bar below battery on welcome screen**
    LCD_CMD_UPDATE_DFU_STATUS_TEXT,   // **NEW: Show/hide DFU status line (e.g. "DFU Updating... 45%") below battery**
    LCD_CMD_SHOW_PATTERN,          // **NEW: Show specific pattern by ID**
    LCD_CMD_CLEAR_DISPLAY,         // **NEW: Clear display**
    LCD_CMD_INVALIDATE_FULL_SCREEN, /* Mark full screen dirty + request one LVGL refresh (thread-safe via msgq) */
    LCD_CMD_INVALIDATE_VISIBLE_UI, /* Invalidate current pattern roots only (e.g. after software depth) */
    LCD_CMD_UPDATE_HEIGHT,
    LCD_CMD_UPDATE_DYNAMIC_FONT     // **NEW: Update dynamic font in LVGL thread**
} display_cmd_type_t;

/* Display on/off control functions | 显示开关控制函数 */
void set_display_onoff(bool state);
bool get_display_onoff(void);

#define MAX_TEXT_LEN 247

typedef struct
{
    uint8_t brightness;
    uint8_t mirror;
} lcd_open_param_t;

typedef struct
{
    uint8_t pattern_id;  // **NEW: Pattern ID for cycling**
} lcd_pattern_param_t;

typedef struct
{
    uint8_t show;   // 1 = show bar and set value, 0 = hide bar | 1=显示并更新 0=隐藏
    uint8_t percent;  // 0..100 progress | 进度 0..100
} lcd_dfu_progress_param_t;

typedef struct
{
    char text[MAX_TEXT_LEN + 1];  // **NEW: Protobuf text content**
} lcd_protobuf_text_param_t;

typedef struct
{
    uint16_t x;                   // X coordinate (0-580)
    uint16_t y;                   // Y coordinate (0-420)
    uint16_t font_size;           // Font size (12,14,16,18,24,30,48)
    uint32_t color;               // Text color (RGB hex)
    char text[MAX_TEXT_LEN + 1];  // Positioned text content
} lcd_positioned_text_param_t;

typedef struct
{
    uint16_t height;
} lcd_height_param_t;

typedef struct
{
    const lv_font_t *font_ptr;
} lcd_font_update_param_t;

typedef union
{
    lcd_open_param_t open;
    lcd_pattern_param_t pattern;  // **NEW: Pattern parameter**
    lcd_protobuf_text_param_t protobuf_text;  // **NEW: Protobuf text parameter**
    lcd_positioned_text_param_t positioned_text;  // Positioned text (x/y/font/color/text)
    lcd_dfu_progress_param_t dfu_progress;    // **NEW: DFU progress bar (show + percent)**
    lcd_height_param_t height;
    lcd_font_update_param_t font_update;
    // 其它命令参数结构体可继续扩展
} display_param_u;

typedef struct
{
    display_cmd_type_t type;
    display_param_u p;
} display_cmd_t;


void display_open(void);


int display_set_translation_pair(display_biz_lang_t src_lang, display_biz_lang_t dst_lang);
void display_get_translation_pair(display_biz_lang_t *src_lang, display_biz_lang_t *dst_lang);

static void update_display_height(uint16_t height);

void display_update_height(uint16_t height);

// **NEW: Thread-safe protobuf text update function**
void display_update_protobuf_text(const char *text_content);

/* Route a text payload to the active display scene.
 * In caption/welcome scene it updates the scrolling caption state.
 * In positioned scene it renders the text at the given coordinates. */
void display_submit_text_payload(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color);

/* Route scrolling text payload to the caption scene. */
void display_submit_scrolling_text_payload(const char *text_content);

/* Render text at an absolute (x, y) position on the caption overlay. Thread-safe. */
void display_update_positioned_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color);

// **NEW: Clear display function**
void display_clear_screen(void);

/** After driver-only changes (e.g. software depth), force LVGL to flush the whole screen. Thread-safe. */
void display_request_full_redraw(void);

/** Mark dirty only the UI roots for the current pattern (less tearing than full screen). Thread-safe. */
void display_request_visible_redraw(void);

/* Snapshot whether the shared Pattern 4 UI is still showing the welcome state. */
bool display_is_welcome_screen_active(void);

void display_close(void);

/** Request welcome screen to refresh battery line (no-op if welcome not active). Call after battery update. */
void display_request_welcome_battery_refresh(void);

/** BLE connection lifecycle events. The display module decides what UI changes (e.g. reset
 * caption ingest state on connect, return to welcome screen on disconnect) follow each one;
 * callers just signal what happened. Thread-safe. */
void display_handle_bt_connected(void);
void display_handle_bt_disconnected(void);

/** Update DFU progress bar on welcome screen (below battery). show=1 to show and set percent (0..100), show=0 to hide. Thread-safe. */
void display_update_dfu_progress(uint8_t show, uint8_t percent);

/** Update DFU status text line below battery (e.g. "DFU Updating... 45% (120 KB)"). text=NULL or "" to hide. Thread-safe. */
void display_update_dfu_status_text(const char *text);

void lvgl_display_thread(void);
#endif // !_MOS_LVGL_DISPLAY_H_
