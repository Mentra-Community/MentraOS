/***
 * @Author       : Cole
 * @Date         : 2025-07-31 10:50:44
 * @LastEditTime : 2025-07-31 20:36:52
 * @FilePath     : mos_lvgl_display.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

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

/* 消息队列的命令类型 */
typedef enum
{
    LCD_CMD_INIT,
    LCD_CMD_OPEN,
    LCD_CMD_CLOSE,
    LCD_CMD_TEXT,
    LCD_CMD_DATA,
    LCD_CMD_CYCLE_PATTERN,  // **NEW: Pattern cycling command**
    LCD_CMD_UPDATE_PROTOBUF_TEXT,  // **NEW: Update container with protobuf text**
    LCD_CMD_UPDATE_XY_TEXT,        // **NEW: Pattern 5 XY positioned text**
    LCD_CMD_UPDATE_WELCOME_BATTERY,  // **NEW: Refresh welcome label with current battery (60s period)**
    LCD_CMD_SHOW_WELCOME_SCREEN,      // **NEW: Return to welcome screen (e.g. after BLE disconnect)**
    LCD_CMD_UPDATE_DFU_PROGRESS,      // **NEW: Show/update DFU progress bar below battery on welcome screen**
    LCD_CMD_UPDATE_DFU_STATUS_TEXT,   // **NEW: Show/hide DFU status line (e.g. "DFU Updating... 45%") below battery**
    LCD_CMD_GRAYSCALE_HORIZONTAL,  // **NEW: Direct A6N horizontal grayscale**
    LCD_CMD_GRAYSCALE_VERTICAL,    // **NEW: Direct A6N vertical grayscale**
    LCD_CMD_CHESS_PATTERN,         // **NEW: Direct A6N chess pattern**
    LCD_CMD_SHOW_PATTERN,          // **NEW: Show specific pattern by ID**
    LCD_CMD_CLEAR_DISPLAY,         // **NEW: Clear display**
    LCD_CMD_UPDATE_HEIGHT
} display_cmd_type_t;

/* Display on/off control functions | 显示开关控制函数 */
void set_display_onoff(bool state);
bool get_display_onoff(void);

#define MAX_TEXT_LEN 128
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
    uint16_t x;                   // **NEW: X coordinate (0-580)**
    uint16_t y;                   // **NEW: Y coordinate (0-420)**
    uint16_t font_size;           // **NEW: Font size (12,14,16,18,24,30,48)**
    uint32_t color;               // **NEW: Text color (RGB hex)**
    char text[MAX_TEXT_LEN + 1];  // **NEW: XY positioned text content**
} lcd_xy_text_param_t;

typedef struct 
{
    uint16_t height;
} lcd_height_param_t;

typedef union
{
    lcd_text_param_t text;
    lcd_open_param_t open;
    lcd_pattern_param_t pattern;  // **NEW: Pattern parameter**
    lcd_protobuf_text_param_t protobuf_text;  // **NEW: Protobuf text parameter**
    lcd_xy_text_param_t xy_text;              // **NEW: XY positioned text parameter**
    lcd_dfu_progress_param_t dfu_progress;    // **NEW: DFU progress bar (show + percent)**
    lcd_height_param_t height;
    // 其它命令参数结构体可继续扩展
} display_param_u;

typedef struct
{
    display_cmd_type_t type;
    display_param_u p;
} display_cmd_t;

void scroll_text_create(lv_obj_t *parent,
                        lv_coord_t x, lv_coord_t y,
                        lv_coord_t w, lv_coord_t h,
                        const char *txt,
                        const lv_font_t *font,
                        uint32_t time_ms);


void scroll_text_stop(void);

void display_open(void);

// **NEW: Thread-safe pattern cycling function**
void display_cycle_pattern(void);

static void update_display_height(uint16_t height);

void display_update_height(uint16_t height);

// **NEW: Thread-safe protobuf text update function**
void display_update_protobuf_text(const char *text_content);

// **NEW: Direct A6N pattern functions**
void display_draw_horizontal_grayscale(void);
void display_draw_vertical_grayscale(void);
void display_draw_chess_pattern(void);

// **NEW: Pattern 5 XY Text Positioning function**
void display_update_xy_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color);

// **NEW: Clear display function**
void display_clear_screen(void);

// **NEW: Get current pattern ID for conditional logic**
int display_get_current_pattern(void);

void display_close(void);

/** Request welcome screen to refresh battery line (no-op if welcome not active). Call after battery update. */
void display_request_welcome_battery_refresh(void);

/** Return to welcome screen (e.g. after BLE disconnect). Thread-safe, sends command to LVGL. */
void display_show_welcome_screen(void);

/** Update DFU progress bar on welcome screen (below battery). show=1 to show and set percent (0..100), show=0 to hide. Thread-safe. */
void display_update_dfu_progress(uint8_t show, uint8_t percent);

/** Update DFU status text line below battery (e.g. "DFU Updating... 45% (120 KB)"). text=NULL or "" to hide. Thread-safe. */
void display_update_dfu_status_text(const char *text);

void display_send_frame(void *data_ptr);

// void handle_display_text(const mentraos_ble_DisplayText *txt);
void lvgl_display_thread(void);
void cycle_test_pattern(void);  // Cycle through test patterns
#endif // !_MOS_LVGL_DISPLAY_H_