/***
 * @Author       : XK
 * @Date         : 2025-06-07 17:17:09
 * @LastEditTime : 2025-07-03 09:41:42
 * @FilePath     : a6m_0011.h
 * @Description  :
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#ifndef _A6M_0011_H_
#define _A6M_0011_H_
#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
// 颜色定义 // Color definitions
#define COLOR_BRIGHT     0xFF  // 亮色 // Bright color
#define BACKGROUND_COLOR 0x00  // 背景色(暗色) // Background color (dark)
#define A6M_0011_LCD_READ_ADDRESS   0x79
#define A6M_0011_LCD_WRITE_ADDRESS  0x78
#define A6M_0011_LCD_DATA_REG     0X02      // 数据寄存器 // Data register
#define A6M_0011_LCD_LOCALITY_REG 0X002A00  // 行地址模式寄存器 // Row address mode register
#define A6M_0011_LCD_CMD_REG      0X003C00  // 先行命令寄存器 // Line command register

#define A6M_0011_LCD_TEST_REG              0X8F  // 测试模式[0X00] // Test mode [0x00]
#define A6M_0011_LCD_HD_REG                0XDD  // 水平方向平移[0X81] // Horizontal shift [0x81]
#define A6M_0011_LCD_HORIZONTAL_MIRROR_REG 0XDE  // 水平镜像模式[0X01] // Horizontal mirror mode [0x01]
#define A6M_0011_LCD_SB_REG                0XE2  // 模拟亮度调节[0X19]，范围 0x00~0x19 // Analog brightness adjustment [0x19], range 0x00~0x19
#define A6M_0011_LCD_VD_REG              0X01  // 垂直方向平移[0x00] 0-15 // Vertical shift [0x00], range 0-15
#define A6M_0011_LCD_VERTICAL_MIRROR_REG 0X05  // 垂直镜像 [0x19] // Vertical mirror [0x19]

/* 最高位（bit7）是“偏移功能使能”标志，低 7 位表示偏移步数 */
/* The highest bit (bit7) is the "shift enable" flag, the lower 7 bits represent the shift steps */
#define A6M_0011_SHIFT_ENABLE (1U << 7)
#define A6M_0011_SHIFT_MASK   0x7F
#define A6M_0011_SHIFT_CENTER (A6M_0011_SHIFT_ENABLE | 0x00)

/** 打开镜像功能（高 1 位），低 7 位为 0 */
/** Enable mirror function (highest bit = 1), lower 7 bits = 0 */
#define A6M_0011_MIRROR_ENABLE (1U << 7)  // 0x80

typedef enum
{
    HORIZONTAL_DIRECTION_SHIFT = 0,  // 水平方向平移 // Horizontal shift
    VERTICAL_DIRECTION_SHIFT   = 1,  // 垂直方向偏移 // Vertical shift
} direction_shift;

typedef enum
{
    MOVE_DEFAULT = 0,  // 默认 // Default
    MOVE_RIGHT   = 1,  // 右移 // Shift right
    MOVE_LEFT    = 2,  // 左移 // Shift left
    MOVE_UP      = 3,  // 上移 // Shift up
    MOVE_DOWN    = 4,  // 下移 // Shift down
    MOVE_MAX     = 5,  // 最大值 // Maximum
} move_mode;

typedef struct
{
    uint8_t       *tx_buf_bulk;                          // 多行 SPI 缓冲（指针） // Multi-line SPI buffer (pointer)
    uint16_t       screen_width; /* 屏幕宽度（缓存） */  /* Screen width (cache) */
    uint16_t       screen_height; /* 屏幕高度（缓存） */ /* Screen height (cache) */
    bool           initialized;
    struct k_timer lvgl_tick; /* 刷新定时器 */ /* Refresh timer */
} a6m_0011_data;

typedef struct
{
    const struct spi_dt_spec  spi; /* SPI接口配置*/                /* SPI interface configuration */
    const struct gpio_dt_spec left_cs; /* 左cs引脚 */              /* Left CS pin */
    const struct gpio_dt_spec right_cs; /* 右cs引脚 */             /* Right CS pin */
    const struct gpio_dt_spec reset; /* 复位引脚 */                /* Reset pin */
    const struct gpio_dt_spec vcom; /* VCOM引脚 */                 /* VCOM pin */
    const struct gpio_dt_spec v1_8; /* V1.8引脚 */                 /* V1.8 pin */
    const struct gpio_dt_spec v0_9; /* V0.8引脚 */                 /* V0.8 pin */
    uint16_t                  screen_width; /* 屏幕宽度（像素） */ /* Screen width (pixels) */
    uint16_t                  screen_height; /* 屏幕高度（行） */  /* Screen height (rows) */
} a6m_0011_config;

typedef enum
{
    MIRROR_NORMAL = 0,  // 不翻转 // No mirror
    MIRROR_HORZ   = 1,  // 水平翻转 // Horizontal mirror
    MIRROR_VERT   = 2,  // 垂直翻转 // Vertical mirror
    MIRROR_BOTH   = 3,  // 水平和垂直翻转 // Both horizontal & vertical mirror
} mirror_mode_t;

int a6m_0011_set_shift(move_mode mode, uint8_t pixels);

int a6m_0011_set_brightness(uint8_t brightness);

void a6m_0011_power_on(void);

void a6m_0011_power_off(void);

int a6m_0011_set_mirror(mirror_mode_t mode);

int a6m_0011_clear_screen(bool color_on);

void a6m_0011_open_display(void);

void a6m_0011_init_sem_give(void);

int a6m_0011_init_sem_take(void);

int a6m_0011_read_reg(uint8_t reg);
int a6m_0011_write_reg(uint8_t reg, uint8_t param);
#endif /* _a6m_0011_H_ */
