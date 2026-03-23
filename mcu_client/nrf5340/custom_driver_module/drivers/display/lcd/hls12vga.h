/***
 * @Author       : Cole
 * @Date         : 2025-08-18 19:27:06
 * @LastEditTime : 2025-08-19 14:40:56
 * @FilePath     : hls12vga.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */
#ifndef _HLS12VGA_H_
#define _HLS12VGA_H_
#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
// Color definitions
#define COLOR_BRIGHT     0xFF  // 亮色; bright color
#define BACKGROUND_COLOR 0x00  // 背景色(暗色); Background color (dark color)

#define LCD_READ_ADDRESS  0x79
#define LCD_WRITE_ADDRESS 0x78

// Register definitions
#define HLS12VGA_LCD_DATA_REG     0X02      // 数据寄存器; data register
#define HLS12VGA_LCD_LOCALITY_REG 0X002A00  // 行地址模式寄存器; Memory address mode register
#define HLS12VGA_LCD_CMD_REG      0X003C00  // 0X002C00      // 先行命令寄存器; Preceding Command Register

#define HLS12VGA_LCD_GRAY_REG   0X00  // 灰度模式; Grayscale mode
#define HLS12VGA_LCD_TEST_REG   0X1B  // 测试模式; test pattern
#define HLS12VGA_LCD_MIRROR_REG 0X1C  // 镜像模式; Mirror mode
#define HLS12VGA_LCD_PWM_REG    0X1D  // PWM 亮度调节; PWM brightness adjustment
#define HLS12VGA_LCD_HD_REG     0X1F  // 水平方向平移; Horizontal shift
#define HLS12VGA_LCD_VD_REG     0X20  // 垂直方向平移; Vertical shift
#define HLS12VGA_LCD_SB_REG     0X23  // 模拟亮度调节，范围 0x00~0xff; Analog brightness adjustment, range 0x00~0xff
#define HLS12VGA_LCD_END_REG    0X24  // 结束地址; End address

#define HLS12VGA_SHIFT_CENTER 8  // 默认居中时寄存器中的值; Default value for centering in register
#define HLS12VGA_SHIFT_MAX    8  // 最多偏移像素数; Maximum pixel offset
typedef enum
{
    HORIZONTAL_DIRECTION_SHIFT = 0,  // 水平方向平移; horizontal shift
    VERTICAL_DIRECTION_SHIFT   = 1,  // 垂直方向偏移; vertical shift
} direction_shift;
typedef enum
{
    MOVE_DEFAULT = 0,  // 默认; default
    MOVE_RIGHT   = 1,  // 右移; move right
    MOVE_LEFT    = 2,  // 左移; move left
    MOVE_UP      = 3,  // 上移; move up
    MOVE_DOWN    = 4,  // 下移; move down
} move_mode;

typedef struct
{
    uint8_t       *tx_buf_bulk;   // 多行 SPI 缓冲（指针）; multi-line SPI buffer (pointer)
    uint16_t       screen_width;  /* 屏幕宽度（缓存）; screen width (cache) */
    uint16_t       screen_height; /* 屏幕高度（缓存）; screen height (cache) */
    bool           initialized;
    struct k_timer lvgl_tick; /* 刷新定时器; refresh timer */
} hls12vga_data;
typedef struct
{
    const struct spi_dt_spec  spi;           /* SPI接口配置; SPI interface config */
    const struct gpio_dt_spec left_cs;       /* 左cs引脚; left cs pin */
    const struct gpio_dt_spec right_cs;      /* 右cs引脚; right cs pin */
    const struct gpio_dt_spec reset;         /* 复位引脚; reset pin */
    const struct gpio_dt_spec vcom;          /* VCOM引脚; VCOM pin */
    const struct gpio_dt_spec v1_8;          /* V1.8引脚; V1.8 pin */
    const struct gpio_dt_spec v0_9;          /* V0.8引脚; V0.8 pin */
    uint16_t                  screen_width;  /* 屏幕宽度（像素）; screen width (pixels) */
    uint16_t                  screen_height; /* 屏幕高度（行）; screen height (rows) */
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

int hls12vga_set_gray16_mode(void);
#endif /* _HLS12VGA_H_ */
