/***
 * @Author       : Cole
 * @Date         : 2025-07-31 20:19:54
 * @LastEditTime : 2025-09-02 20:06:42
 * @FilePath     : a6n.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _A6N_H_
#define _A6N_H_
#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
// 颜色定义 | Color definitions
#define COLOR_BRIGHT                0xFF  // 亮色 | Bright color
#define BACKGROUND_COLOR            0x00  // 背景色(暗色) | Background color (dark)

// SPI 命令字 | SPI Command Bytes
#define A6N_LCD_WRITE_ADDRESS       0x78  // Bank0 写命令 | Bank0 write command
#define A6N_LCD_READ_ADDRESS        0x79  // Bank0 读命令 | Bank0 read command
#define A6N_LCD_BANK_SEL_REG        0x7A  // Bank1 写命令 | Bank1 write command (NOT a register!)
#define A6N_LCD_BANK1_READ          0x7B  // Bank1 读命令 | Bank1 read command

// Bank 定义（用于参数传递）| Bank definitions (for parameter passing)
#define A6N_LCD_BANK0               0x00  // Bank0 (默认) | Bank0 (default)
#define A6N_LCD_BANK1               0x01  // Bank1

/**
 * SPI/QSPI 显示数据传输指令定义 | SPI/QSPI Display Data Transfer Command Definitions
 * ====================================================================
 * 
 * 支持的显示模式 | Supported display modes:
 *   - 1线 SPI GRAY256 (8-bit) | 1-wire SPI GRAY256 (8-bit)
 *   - 1线 SPI GRAY16 (4-bit)  | 1-wire SPI GRAY16 (4-bit)
 *   - 4线 QSPI GRAY256 (8-bit) | 4-wire QSPI GRAY256 (8-bit)
 *   - 4线 QSPI GRAY16 (4-bit)  | 4-wire QSPI GRAY16 (4-bit)
 *
 * 全屏/局部写数据指令 (4字节固定前缀) | Full/Partial write data command (4-byte fixed prefix):
 *   0x02 0x00 0x2C 0x00  或 | or  0x02 0x00 0x3C 0x00
 *
 * 数据格式 | Data format:
 *   - GRAY256 (8-bit): 1像素 = 8bit, 每字节1个像素 | 1 pixel = 8-bit, 1 pixel per byte
 *   - GRAY16 (4-bit):  1像素 = 4bit, 每字节2个像素 | 1 pixel = 4-bit, 2 pixels per byte
 *   - 字节序: MSB在前，LSB在后 | Byte order: MSB first, LSB last
 *
 * 全屏模式数据量 | Full screen data size:
 *   - GRAY256: 640×480 = 307,200 字节 | 307,200 bytes
 *   - GRAY16:  640×480÷2 = 153,600 字节 | 153,600 bytes
 *
 * 每行数据量 | Bytes per row:
 *   - GRAY256: 640 字节/行 | 640 bytes/row
 *   - GRAY16:  320 字节/行 | 320 bytes/row
 *
 * ⚠️ 重要约束 | Important constraint:
 *   每次 CS 拉低发送的数据量必须是每行数据量的整数倍 | 
 *   Data sent per CS cycle must be multiple of bytes-per-row
 *   例如 GRAY16 模式: 最小320字节，可以是320、640、960... | 
 *   e.g. GRAY16 mode: minimum 320 bytes, can be 320, 640, 960...
 *
 * ====================================================================
 */
#define A6N_LCD_DATA_REG            0X02      // 数据寄存器 | Data register
#define A6N_LCD_WRITE_DATA_CMD      0X02002C00  // 写数据指令1 (4字节) | Write data command 1 (4-byte)
#define A6N_LCD_CMD_REG             0X02003C00  // 写数据指令2 (4字节) | Write data command 2 (4-byte)

// 每行字节数 | Bytes per row
#define A6N_BYTES_PER_ROW_GRAY256   640  // GRAY256 模式每行字节数 | Bytes per row in GRAY256 mode
#define A6N_BYTES_PER_ROW_GRAY16    320  // GRAY16 模式每行字节数 | Bytes per row in GRAY16 mode

/**
 * 局部更新指令定义 | Partial Update Command Definitions
 * ====================================================================
 * 局部更新数据区域指令格式 (8字节) | Partial update region command format (8 bytes):
 *   Byte[0:3]: 0x02 0x00 0x2A 0x00 (固定前缀) | Fixed prefix
 *   Byte[4:5]: ADDR1 (起始行，大端序，0-479) | Start row (big-endian, 0-479)
 *   Byte[6:7]: ADDR2 (终止行，大端序，0-479) | End row (big-endian, 0-479)
 *
 * 示例 | Examples:
 *   更新第0-99行 | Update rows 0-99:
 *     0x02 0x00 0x2A 0x00  0x00 0x00  0x00 0x63
 *   更新第100-199行 | Update rows 100-199:
 *     0x02 0x00 0x2A 0x00  0x00 0x64  0x00 0xC7
 *
 * 使用流程 | Usage flow:
 *   1. 发送区域指令 (8字节) | Send region command (8 bytes)
 *   2. 等待 ≥1us | Wait ≥1us
 *   3. 发送写数据指令 (4字节) | Send write data command (4 bytes)
 *   4. 发送显示数据 | Send display data
 *   5. 等待 ≥1us | Wait ≥1us
 *   6. 重复步骤1-5（如有更多局部更新）| Repeat 1-5 (if more updates)
 *
 * 注意事项 | Important notes:
 *   1. 间隔等待时间 ≥1us，time时间≥3ns | Wait ≥1us between commands, time ≥3ns
 *   2. 数据必须以行为单位 | Data must be row-aligned
 *   3. 使用前必须先发送一帧全屏数据 (640x480) | Must send full frame (640x480) first
 *   4. 每次局部更新前都需发送区域指令 | Must send region command before each update
 *   5. CS保持低电平时可连续发送数据，否则每次需发送写指令 | 
 *      If CS stays low, continuous data; otherwise send write cmd each time
 *   6. 行地址: 0-479 (共480行) | Row address: 0-479 (total 480 rows)
 * ====================================================================
 */
#define A6N_LCD_LOCALITY_REG        0X002A00  // 局部更新区域指令前缀 | Partial update region command prefix

/**
 * A6N 寄存器映射表 | A6N Register Map
 * ====================================================================
 * Bank0 寄存器通过命令字 0x78 访问 | Bank0 accessed via command 0x78
 * Bank1 寄存器通过命令字 0x7A 访问 | Bank1 accessed via command 0x7A
 * ====================================================================
 */

// Bank0 寄存器定义 | Bank0 Register Definitions
#define A6N_LCD_OSC_CLK_REG            0x78  // OSC 时钟配置 [默认:0x0E] | OSC clock config [default:0x0E]
                                              //   配合 0x7C 设置自刷新帧率 | Works with 0x7C to set refresh rate
#define A6N_LCD_OSC_CLK2_REG           0x7C  // OSC 时钟配置 [默认:0x03] | OSC clock config [default:0x03]
                                              //   配合 0x78 设置自刷新帧率 | Works with 0x78 to set refresh rate
#define A6N_LCD_SOFT_RESET_REG         0x80  // 软复位寄存器 [默认:0xFF] | Soft reset register [default:0xFF]
#define A6N_LCD_SELFTEST_REG           0x8F  // 自测试寄存器 [默认:0x00] | Self-test register [default:0x00]
                                              //   bit7: 功能使能 (0=关闭,1=开启) | Enable (0=off,1=on)
                                              //   bit[4:0]: 测试图选择 | Test pattern select
#define A6N_LCD_DISPLAY_MODE_REG       0xBE  // 显示数据格式 [默认:0x82] | Display data format [default:0x82]
                                              //   0x82: GRAY256 (8-bit grayscale)
                                              //   0x84: GRAY16 (4-bit grayscale)
#define A6N_LCD_EFUSE_CTRL_REG         0xCF  // Efuse 读写控制 [默认:0x00] | Efuse R/W control [default:0x00]
#define A6N_LCD_ANALOG_RESET_REG       0xD9  // 模拟模块软复位 [默认:0xFF] | Analog soft reset [default:0xFF]
#define A6N_LCD_SB_REG                 0xE2  // 模拟亮度调节 [默认:上电后读取] | Analog brightness [default:read after power-on]
                                              //   最大值=默认值，相邻等级差值≥2 | Max=default, adjacent levels differ by ≥2
                                              //   最多支持64级可调 | Up to 64 brightness levels
#define A6N_LCD_HD_REG                 0xEF  // 水平镜像+平移 [默认:0x48] | H-mirror + shift [default:0x48]
                                              //   bit7: 水平镜像使能 (0=关闭,1=开启) | H-mirror enable
                                              //   bit[4:0]: 水平平移 (0-16, 8=居中) | H-shift (0-16, 8=center)
#define A6N_LCD_VD_REG                 0xF0  // 垂直平移 [默认:0x08] | V-shift [default:0x08]
                                              //   bit[4:0]: 垂直平移 (0-16, 8=居中) | V-shift (0-16, 8=center)
#define A6N_LCD_TEMP_HIGH_REG          0xF7  // 高温保护阈值 [默认:0xB6] | High temp threshold [default:0xB6]
#define A6N_LCD_TEMP_LOW_REG           0xF8  // 低温恢复阈值 [默认:0x8C] | Low temp recovery [default:0x8C]

// 自刷新帧率配置 | Self-refresh frame rate configuration
// ====================================================================
// SPI时钟(MHz) | 0x78值 | 0x7C值 | 帧率(Hz) | SPI Clock | 0x78  | 0x7C  | FPS
// ≤16           0x0E     0x16     45Hz      ≤16 MHz    0x0E    0x16   45Hz
// ≤24           0x0E     0x14     60Hz      ≤24 MHz    0x0E    0x14   60Hz  
// ≤32(默认)     0x0E     0x13     90Hz      ≤32 MHz    0x0E    0x13   90Hz (default)
// ≤48           0x0D     0x12     120Hz     ≤48 MHz    0x0D    0x12   120Hz
// ====================================================================
#define A6N_FRAMERATE_45HZ_0x78        0x0E  // 45Hz 配置 | 45Hz config
#define A6N_FRAMERATE_45HZ_0x7C        0x16
#define A6N_FRAMERATE_60HZ_0x78        0x0E  // 60Hz 配置 | 60Hz config  
#define A6N_FRAMERATE_60HZ_0x7C        0x14
#define A6N_FRAMERATE_90HZ_0x78        0x0E  // 90Hz 配置 (默认) | 90Hz config (default)
#define A6N_FRAMERATE_90HZ_0x7C        0x13  // 或 0x03 | or 0x03
#define A6N_FRAMERATE_120HZ_0x78       0x0D  // 120Hz 配置 | 120Hz config
#define A6N_FRAMERATE_120HZ_0x7C       0x12

// Bank1 寄存器定义 | Bank1 Register Definitions  
#define A6N_LCD_DEMURA_EN_REG          0x55  // Demura 功能使能 [默认:0x80] | Demura enable [default:0x80]
                                              //   bit7: Demura使能 (0=关闭,1=开启) | Enable (0=off,1=on)

/* 最高位（bit7）是“偏移功能使能”标志，低 7 位表示偏移步数 */
/* The highest bit (bit7) is the "shift enable" flag, the lower 7 bits represent the shift steps */
#define A6N_SHIFT_ENABLE (1U << 7)
#define A6N_SHIFT_MASK   0x7F
#define A6N_SHIFT_CENTER (A6N_SHIFT_ENABLE | 0x00)

/** 打开镜像功能（高 1 位），低 7 位为 0 */
/** Enable mirror function (highest bit = 1), lower 7 bits = 0 */
#define A6N_MIRROR_ENABLE (1U << 7)  // 0x80

// ================================================================
// 镜像模式定义 Mirror Mode (Spec V0.4)
// ================================================================
typedef enum {
    A6N_MIRROR_NORMAL = 0,   ///< 正常显示 (Normal orientation)
    A6N_MIRROR_H_FLIP = 1    ///< 水平镜像 (Left-right flip)
} a6n_mirror_mode_t;
typedef struct
{
    uint8_t       *tx_buf_bulk;                          // 多行 SPI 缓冲（指针） // Multi-line SPI buffer (pointer)
    uint16_t       screen_width; /* 屏幕宽度（缓存） */  /* Screen width (cache) */
    uint16_t       screen_height; /* 屏幕高度（缓存） */ /* Screen height (cache) */
    bool           initialized;
    struct k_timer lvgl_tick; /* 刷新定时器 */ /* Refresh timer */
} a6n_data;

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
} a6n_config;

typedef enum
{
    MIRROR_NORMAL = 0,  // 不翻转 // No mirror
    MIRROR_HORZ   = 1,  // 水平翻转 // Horizontal mirror
    MIRROR_VERT   = 2,  // 垂直翻转 // Vertical mirror
    MIRROR_BOTH   = 3,  // 水平和垂直翻转 // Both horizontal & vertical mirror
} mirror_mode_t;

int a6n_set_shift_mirror(uint8_t h_shift, uint8_t v_shift, a6n_mirror_mode_t mirror);

int a6n_get_max_brightness(void);

int a6n_set_brightness(uint8_t brightness);

int a6n_enable_selftest(bool enable, uint8_t pattern);

void a6n_power_on(void);

void a6n_power_off(void);

void a6n_io_off(void);

int a6n_set_mirror(mirror_mode_t mode);

int a6n_clear_screen(bool color_on);

void a6n_open_display(void);

void a6n_init_sem_give(void);

int a6n_init_sem_take(void);


int a6n_read_reg(uint8_t bank_id, int mode, uint8_t reg);


int a6n_write_reg(uint8_t bank_id, uint8_t reg, uint8_t param);

int a6n_write_reg_bank(const struct device *dev, uint8_t bank_id, uint8_t reg, uint8_t val);
// Enable or disable 4bpp (Gray16) transfer mode at runtime.
// When enabled, driver packs two pixels per byte and programs panel gray mode accordingly.
int hls12vga_set_gray_mode(bool enable_gray16);

// **NEW: Direct a6n Grayscale Test Patterns**
int a6n_draw_horizontal_grayscale_pattern(void);

int a6n_draw_vertical_grayscale_pattern(void);

int a6n_draw_chess_pattern(void);

int a6n_set_gray16_mode(void);
#endif // A6N_H
