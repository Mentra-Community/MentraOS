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
    LCD_CMD_GRAYSCALE_HORIZONTAL,  // **NEW: Direct A6N horizontal grayscale**
    LCD_CMD_GRAYSCALE_VERTICAL,    // **NEW: Direct A6N vertical grayscale**
    LCD_CMD_CHESS_PATTERN,         // **NEW: Direct A6N chess pattern**
    LCD_CMD_SHOW_PATTERN,          // **NEW: Show specific pattern by ID**
    LCD_CMD_CLEAR_ALL,             // **NEW: Clear all display content**
} display_cmd_type_t;
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

typedef union
{
    lcd_text_param_t text;
    lcd_open_param_t open;
    lcd_pattern_param_t pattern;  // **NEW: Pattern parameter**
    lcd_protobuf_text_param_t protobuf_text;  // **NEW: Protobuf text parameter**
    lcd_xy_text_param_t xy_text;              // **NEW: XY positioned text parameter**
    // 其它命令参数结构体可继续扩展
} display_param_u;

typedef struct
{
    display_cmd_type_t type;
    display_param_u p;
} display_cmd_t;
/**
 * @brief 在指定区域创建一个垂直循环滚动长文本
 * @param parent  父对象，一般使用 lv_scr_act()
 * @param x       区域左上角 X 坐标
 * @param y       区域左上角 Y 坐标
 * @param w       区域宽度（像素）
 * @param h       区域高度（像素）
 * @param txt     要滚动显示的文本
 * @param font    字体指针，如 &lv_font_montserrat_48
 * @param time_ms 从滚动到末端并返回所用时间（毫秒）
 */
void scroll_text_create(lv_obj_t *parent,
                        lv_coord_t x, lv_coord_t y,
                        lv_coord_t w, lv_coord_t h,
                        const char *txt,
                        const lv_font_t *font,
                        uint32_t time_ms);

/**
 * @brief 停止并移除滚动区域
 */
void scroll_text_stop(void);

void display_open(void);

// **NEW: Thread-safe pattern cycling function**
void display_cycle_pattern(void);

// **NEW: Thread-safe protobuf text update function**
void display_update_protobuf_text(const char *text_content);

// **NEW: Clear display function**
void display_clear_all(void);

// **NEW: Direct A6N pattern functions**
void display_draw_horizontal_grayscale(void);
void display_draw_vertical_grayscale(void);
void display_draw_chess_pattern(void);

// **NEW: Pattern 5 XY Text Positioning function**
void display_update_xy_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color);

// **NEW: Get current pattern ID for conditional logic**
int display_get_current_pattern(void);

void display_close(void);

void display_send_frame(void *data_ptr);

// void handle_display_text(const mentraos_ble_DisplayText *txt);
void lvgl_display_thread(void);
void cycle_test_pattern(void);  // Cycle through test patterns
#endif // !_MOS_LVGL_DISPLAY_H_