/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 10:50:44
 * @LastEditTime : 2025-07-31 16:41:06
 * @FilePath     : mos_lvgl_display.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef _MOS_LVGL_DISPLAY_H_
#define _MOS_LVGL_DISPLAY_H_


#include <lvgl.h>
#include "mentraos_ble.pb.h"
typedef enum
{
    LCD_STATE_INIT = 0,
    LCD_STATE_OFF,
    LCD_STATE_ON,
} display_state_t;

typedef enum
{
    LCD_CMD_INIT,
    LCD_CMD_OPEN,
    LCD_CMD_CLOSE,
    LCD_CMD_TEXT,
    LCD_CMD_DATA,
} display_cmd_type_t;
#define MAX_TEXT_LEN 128
typedef struct {
    char    text[MAX_TEXT_LEN + 1];
    int16_t x;
    int16_t y;
    uint16_t font_code;
    uint32_t font_color;
    uint8_t size;
} lcd_text_param_t;

typedef struct {
    uint8_t brightness;
    uint8_t mirror;
} lcd_open_param_t;
typedef union {
    lcd_text_param_t text;
    lcd_open_param_t open;
   
} display_param_u;

typedef struct {
    display_cmd_type_t   type;
    display_param_u  p;
} display_cmd_t;

void scroll_text_create(lv_obj_t *parent,
                        lv_coord_t x, lv_coord_t y,
                        lv_coord_t w, lv_coord_t h,
                        const char *txt,
                        const lv_font_t *font,
                        uint32_t time_ms);

void scroll_text_stop(void);

void display_open(void);

void display_close(void);

void display_send_frame(void *data_ptr);

void handle_display_text(const mentraos_ble_DisplayText *txt);
void lvgl_dispaly_thread(void);

#endif // !_MOS_LVGL_DISPLAY_H_