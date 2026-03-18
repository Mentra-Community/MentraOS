/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 20:19:54
 * @LastEditTime : 2025-08-01 11:17:02
 * @FilePath     : hls12vga.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef _HLS12VGA_H_
#define _HLS12VGA_H_

#include "bsp_log.h"
// #include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
// 颜色定义
#define COLOR_BRIGHT 0xFF     // 亮色
#define BACKGROUND_COLOR 0x00 // 背景色(暗色)

#define LCD_READ_ADDRESS 0x79
#define LCD_WRITE_ADDRESS 0x78

#define HLS12VGA_LCD_DATA_REG 0X02         // 数据寄存器
#define HLS12VGA_LCD_LOCALITY_REG 0X002A00 // 行地址模式寄存器
#define HLS12VGA_LCD_CMD_REG 0X003C00      // 0X002C00      // 先行命令寄存器

#define HLS12VGA_LCD_GRAY_REG 0X00   // 灰度模式
#define HLS12VGA_LCD_TEST_REG 0X1B   // 测试模式
#define HLS12VGA_LCD_MIRROR_REG 0X1C // 镜像模式
#define HLS12VGA_LCD_PWM_REG 0X1D    // PWM 亮度调节
#define HLS12VGA_LCD_HD_REG 0X1F     // 水平方向平移
#define HLS12VGA_LCD_VD_REG 0X20     // 垂直方向平移
#define HLS12VGA_LCD_SB_REG 0X23     // 模拟亮度调节，范围 0x00~0xff
#define HLS12VGA_LCD_END_REG 0X24    // 结束地址

#define HLS12VGA_SHIFT_CENTER 8 // 默认居中时寄存器中的值
#define HLS12VGA_SHIFT_MAX 8    // 最多偏移像素数
typedef enum
{
    HORIZONTAL_DIRECTION_SHIFT = 0, // 水平方向平移
    VERTICAL_DIRECTION_SHIFT = 1,   // 垂直方向偏移
} direction_shift;
typedef enum
{
    MOVE_DEFAULT = 0, // 默认
    MOVE_RIGHT = 1,   // 右移
    MOVE_LEFT = 2,    // 左移
    MOVE_UP = 3,      // 上移
    MOVE_DOWN = 4,    // 下移
} move_mode;

typedef struct
{
    uint8_t *tx_buf_bulk;   // 多行 SPI 缓冲（指针）
    uint16_t screen_width;  /* 屏幕宽度（缓存） */
    uint16_t screen_height; /* 屏幕高度（缓存） */
    bool initialized;
    struct k_timer lvgl_tick; /* 刷新定时器 */
} hls12vga_data;
typedef struct
{
    const struct spi_dt_spec spi;       /* SPI接口配置*/
    const struct gpio_dt_spec left_cs;  /* 左cs引脚 */
    const struct gpio_dt_spec right_cs; /* 右cs引脚 */
    const struct gpio_dt_spec reset;    /* 复位引脚 */
    const struct gpio_dt_spec vcom;     /* VCOM引脚 */
    const struct gpio_dt_spec v1_8;     /* V1.8引脚 */
    const struct gpio_dt_spec v0_9;     /* V0.8引脚 */
    uint16_t screen_width;              /* 屏幕宽度（像素） */
    uint16_t screen_height;             /* 屏幕高度（行） */
} hls12vga_config;

int hls12vga_set_shift(move_mode mode, uint8_t pixels);

int hls12vga_set_brightness(uint8_t brightness);

void hls12vga_power_on(void);

void hls12vga_power_off(void);

int hls12vga_set_mirror(const uint8_t value);

int hls12vga_clear_screen(bool color_on);

void hls12vga_open_display(void);

void hls12vga_init_sem_give(void);

int hls12vga_init_sem_take(void);
#endif /* _HLS12VGA_H_ */
