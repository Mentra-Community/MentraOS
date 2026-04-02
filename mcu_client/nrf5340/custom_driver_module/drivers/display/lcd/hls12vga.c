/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-22 14:37:18
 * @FilePath     : hls12vga.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "hls12vga.h"

#include <stdio.h>
#include <zephyr/device.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/types.h>
#define LOG_MODULE_NAME CUSTOM_HLS12VGA
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define SCREEN_WIDTH  640
#define SCREEN_HEIGHT 480
#define DT_DRV_COMPAT zephyr_custom_hls12vga

#if DT_NUM_INST_STATUS_OKAY(DT_DRV_COMPAT) == 0
#warning "Custom ls12vga driver enabled without any devices"
#endif
const struct device *dev_hls12vga = DEVICE_DT_GET(DT_INST(0, DT_DRV_COMPAT));

static K_SEM_DEFINE(hls12vga_init_sem, 0, 1);
uint32_t g_frame_count = 0;

// The maximum number of rows written each time can be adjusted according to config lv z vdb size;
#define MAX_LINES_PER_WRITE 120   // 每次写入的最大行数; The maximum number of rows written each time
void hls12vga_init_sem_give(void)
{
    k_sem_give(&hls12vga_init_sem);
}

int hls12vga_init_sem_take(void)
{
    return k_sem_take(&hls12vga_init_sem, K_FOREVER);
}

static int write_reg_side(const struct device *dev, const struct gpio_dt_spec *cs, uint8_t reg, uint8_t val)
{
    if ((!device_is_ready(dev)))
    {
        LOG_ERR("device_is_ready err!!!");
        return -EINVAL;
    }
    if (!gpio_is_ready_dt(cs))
    {
        LOG_ERR("gpio_is_ready_dt err!!!");
        return -EINVAL;
    }

    const hls12vga_config *cfg = dev->config;
    uint8_t                tx[3];
    tx[0]                    = LCD_WRITE_ADDRESS;
    tx[1]                    = reg;
    tx[2]                    = val;
    const struct spi_buf buf = {
        .buf = tx,
        .len = sizeof(tx),
    };
    const struct spi_buf_set tx_set = {
        .buffers = &buf,
        .count   = 1,
    };
    gpio_pin_set_dt(cs, 0);
    int err = spi_write_dt(&cfg->spi, &tx_set);
    gpio_pin_set_dt(cs, 1);

    if (err)
    {
        LOG_ERR("SPI write_reg_side @0x%02x failed: %d", reg, err);
    }
    return err;
}
/**
 * @brief 设置左右/垂直 两路显示的偏移量; Set the offset for the left/right / vertical dual-display mode
 * @param mode: 左右/垂直; Left/right / vertical
 * @param pixels: 偏移量 0->8; Offset 0->8
 */
int hls12vga_set_shift(move_mode mode, uint8_t pixels)
{
    if ((pixels > HLS12VGA_SHIFT_MAX) || (mode > MOVE_DOWN))
    {
        LOG_ERR("Invalid parameters err!!!");
        return -EINVAL;
    }
    const hls12vga_config *cfg  = dev_hls12vga->config;
    int                    err1 = 0, err2 = 0;
    uint8_t                reg_l, val_l, reg_r, val_r;

    switch (mode)
    {
        case MOVE_DEFAULT:
            reg_l = HLS12VGA_LCD_HD_REG;
            val_l = HLS12VGA_SHIFT_CENTER;
            reg_r = HLS12VGA_LCD_HD_REG;
            val_r = HLS12VGA_SHIFT_CENTER;
            break;
        case MOVE_RIGHT:
            reg_l = HLS12VGA_LCD_HD_REG;
            val_l = HLS12VGA_SHIFT_CENTER + pixels; /* 左机向右; Left machine to the right */
            reg_r = HLS12VGA_LCD_HD_REG;
            val_r = HLS12VGA_SHIFT_CENTER - pixels; /* 右机向左; Right machine to the left */
            break;
        case MOVE_LEFT:
            reg_l = HLS12VGA_LCD_HD_REG;
            val_l = HLS12VGA_SHIFT_CENTER - pixels; /* 左机向左; Left machine to the left */
            reg_r = HLS12VGA_LCD_HD_REG;
            val_r = HLS12VGA_SHIFT_CENTER + pixels; /* 右机向右; Right machine to the right */
            break;
        case MOVE_UP:
            reg_l = HLS12VGA_LCD_VD_REG;
            val_l = HLS12VGA_SHIFT_CENTER - pixels; /* 同步向上; Synchronous upward */
            reg_r = HLS12VGA_LCD_VD_REG;
            val_r = HLS12VGA_SHIFT_CENTER - pixels;
            break;
        case MOVE_DOWN:
            reg_l = HLS12VGA_LCD_VD_REG;
            val_l = HLS12VGA_SHIFT_CENTER + pixels; /* 同步向下; Synchronous downward */
            reg_r = HLS12VGA_LCD_VD_REG;
            val_r = HLS12VGA_SHIFT_CENTER + pixels;
            break;
        default:
            return -EINVAL;
    }
    LOG_INF("hls12vga_set_shift: reg_l=%02X, val_l=%d reg_r=%02X, val_r=%d", reg_l, val_l, reg_r, val_r);
    /* 分别对左右两路写寄存器; Write registers separately for both sides */
    err1 = write_reg_side(dev_hls12vga, &cfg->left_cs, reg_l, val_l);
    err2 = write_reg_side(dev_hls12vga, &cfg->right_cs, reg_r, val_r);

    return err1 ?: err2;
}
/**
 * Send data via SPI
 * @param dev      SPI device handle
 * @param data     Pointer to the data buffer to send
 * @param size     Number of bytes to send
 * @param retries  Number of retries on failure
 * @return         0 on success, negative value on error
 */
static int hls12vga_transmit_all(const struct device *dev, const uint8_t *data, size_t size, int retries)
{
    /* 边界条件检查; Boundary condition check */
    if (!dev || !data || size == 0)
    {
        return -EINVAL;
    }
    int                    err    = -1;
    const hls12vga_config *cfg    = dev->config;
    struct spi_buf         tx_buf = {
                .buf = data,
                .len = size,
    };
    struct spi_buf_set tx = {
        .buffers = &tx_buf,
        .count   = 1,
    };

    /* 执行SPI传输（带重试机制）; Execute SPI transmission (with retry mechanism) */
    for (int i = 0; i <= retries; i++)
    {
        gpio_pin_set_dt(&cfg->left_cs, 0);
        gpio_pin_set_dt(&cfg->right_cs, 0);
        err = spi_write_dt(&cfg->spi, &tx);
        gpio_pin_set_dt(&cfg->left_cs, 1);
        gpio_pin_set_dt(&cfg->right_cs, 1);
        if (err == 0)
        {
            return 0; /* 成功; Success */
        }
        k_msleep(1); /* 短暂延迟; Short delay */
        LOG_INF("SPI write failed (attempt %d/%d): %d", i + 1, retries + 1, err);
    }
    return err;
}

/**
 * @Description: Command for local data mode
 * @start_line: Starting line number
 * @end_line: Ending line number
 */
void hls12vga_write_multiple_rows_cmd(const struct device *dev, uint16_t start_line, uint16_t end_line)
{
    uint8_t reg[8] = {0};
    reg[0]         = HLS12VGA_LCD_DATA_REG;
    reg[1]         = (HLS12VGA_LCD_LOCALITY_REG >> 16) & 0xff;
    reg[2]         = (HLS12VGA_LCD_LOCALITY_REG >> 8) & 0xff;
    reg[3]         = HLS12VGA_LCD_LOCALITY_REG & 0xff;
    reg[4]         = (start_line >> 8) & 0xff;
    reg[5]         = start_line & 0xff;
    reg[6]         = (end_line >> 8) & 0xff;
    reg[7]         = end_line & 0xff;
    hls12vga_transmit_all(dev, reg, sizeof(reg), 1);
}

static int hls12vga_blanking_on(struct device *dev)
{
    return 0;
}

static int hls12vga_blanking_off(struct device *dev)
{
    return 0;
}
#if 1  // 4 bit display mode
/* —— 新增：切换到 GRAY16(4bit) 输入格式 —— ;——Added: Switch to GRAY16(4bit) input format ——*/
int hls12vga_set_gray16_mode(void)
{
    /* 寄存器 0x00[2:0] 选择视频格式；1xx = GRAY16（此处用 0b100 = 0x04; 
    Register 0x00[2:0] Select the video format; 1xx = GRAY16 (used here 0b100 = 0x04*/
    uint8_t cmd[3] = {LCD_WRITE_ADDRESS, 0x00, 0x04};
    return hls12vga_transmit_all(dev_hls12vga, cmd, sizeof(cmd), 1);
}

static uint16_t LUT_NIBBLE_TO_2BYTES[16];
static bool     g_lut_inited = false;
/* bit=1 => dark(0x0), bit=0 => bright(0xF)
 * 若想反色，把 (~v) 改成 v 即可（即 bit=1=>0xF, bit=0=>0x0）；
 *If you want to reverse the color, just change (~v) to v (that is, bit=1=>0xF, bit=0=>0x0)
 */
static inline void hls12vga_init_nibble_lut(void)
{
    for (int v = 0; v < 16; ++v)
    {
        /* v 的位含义：b3 b2 b1 b0（b3 是最左像素）；Meaning of v bits: b3 b2 b1 b0 (b3 is the leftmost pixel)
           映射规则：b?==1 → 0x0；b?==0 → 0xF；Mapping rule: bit=1 → 0x0; bit=0 → 0xF */
        int     r     = ~v;                          /* 反转：1->0x0, 0->0xF 的判定使用 (~v)；Inversion: use (~v) to map 1→0x0, 0→0xF*/
        uint8_t byte0 = ((r & 0x8) ? 0xF0 : 0x00)    /* b3 -> 高半字节；b3 -> high nibble*/
                        | ((r & 0x4) ? 0x0F : 0x00); /* b2 -> 低半字节；b2 -> low nibble */
        uint8_t byte1 = ((r & 0x2) ? 0xF0 : 0x00)    /* b1 -> 高半字节；b1 -> high nibble */
                        | ((r & 0x1) ? 0x0F : 0x00); /* b0 -> 低半字节；b0 -> low nibble*/
        LUT_NIBBLE_TO_2BYTES[v] = ((uint16_t)byte0 << 8) | byte1;
    }
    g_lut_inited = true;
}
static int hls12vga_write(const struct device *dev, const uint16_t x, const uint16_t y,
                          const struct display_buffer_descriptor *desc, const void *buf)
{
    const hls12vga_config *cfg    = dev->config;
    hls12vga_data         *data   = dev->data;
    const uint16_t         width  = desc->width;  /* 640 */
    const uint16_t         height = desc->height; /* 待刷新的行数; Number of rows to refresh */
    int                    ret    = 0;
    uint32_t               t0     = k_uptime_get_32();
    if (!g_lut_inited)
    {
        hls12vga_init_nibble_lut();  // 首次调用时初始化 LUT；Initialize LUT lazily
    }
    if (y + height > cfg->screen_height)
    {
        return -ENOTSUP;
    }

    /* 源：LVGL MONO1 (1bpp)；目标：GRAY16 4bpp -> 每行 320B；
       Source: LVGL MONO1 (1bpp); Target: GRAY16 4bpp -> 320B per row */
    const uint8_t *src        = (const uint8_t *)buf;
    uint8_t       *dst_base   = data->tx_buf_bulk + 4; /* 预留 4 字节命令头；Reserve 4B command header */
    const uint16_t src_stride = (width + 7) / 8;       /* 1bpp 源每行字节数；Bytes per source row (1bpp) */
    const uint16_t dst_stride = width / 2; /* 4bpp 目标每行字节数（640/2=320）；Bytes per target row (4bpp) */

    uint16_t remaining = height;
    uint16_t line_off  = 0;  // 行偏移量；Line offset

    while (remaining > 0)
    {
        // 一次写尽量多行（由 TX 缓冲与 MAX_LINES_PER_WRITE 限制）
        // Write as many lines as possible at once (limited by TX buffer size and MAX_LINES_PER_WRITE)
        uint16_t sub_lines = (remaining > MAX_LINES_PER_WRITE) ? MAX_LINES_PER_WRITE : remaining;

        /* —— 用 LUT 将 sub_lines 行从 1bpp 打包为 4bpp（8px -> 4B，1B=2px）
           Use LUT to pack sub_lines rows: 8px -> 4 bytes (1 byte = 2 pixels) —— */
        // uint32_t conv_start = k_cycle_get_32();
        for (uint16_t row = 0; row < sub_lines; row++)
        {
            const uint8_t *src_row = src + (line_off + row) * src_stride;
            uint8_t       *dst_row = dst_base + row * dst_stride;

            /* 每次处理一个源字节（8 个像素）→ 写出 4 个目标字节；
               Process one source byte (8 pixels) → 4 target bytes */
            uint16_t di = 0;
            for (uint16_t sb = 0; sb < src_stride; ++sb)
            {
                uint8_t b  = src_row[sb];
                uint8_t hi = b >> 4;   /* bit7..bit4（左到右前四像素）；High nibble: pixels 7..4 */
                uint8_t lo = b & 0x0F; /* bit3..bit0（左到右后四像素）；Low  nibble: pixels 3..0 */

                uint16_t w0 = LUT_NIBBLE_TO_2BYTES[hi]; /* 两个字节；Two bytes */
                uint16_t w1 = LUT_NIBBLE_TO_2BYTES[lo];

                /* 写入顺序保持“左到右、上到下”；Keep left-to-right order */
                dst_row[di + 0] = (uint8_t)(w0 >> 8);
                dst_row[di + 1] = (uint8_t)(w0 & 0xFF);
                dst_row[di + 2] = (uint8_t)(w1 >> 8);
                dst_row[di + 3] = (uint8_t)(w1 & 0xFF);
                di += 4;
            }
        }
        // uint32_t conv_end = k_cycle_get_32();
        // LOG_INF("Convert %u:lines; took %u:cycles", sub_lines, conv_end - conv_start);
        /* —— 行地址命令（独立 CS 周期）；Row-address command (separate CS window) —— */
        hls12vga_write_multiple_rows_cmd(dev, y + line_off, y + line_off + sub_lines - 1);
        k_busy_wait(1); /* ≥1µs：地址→数据间隔；Address→data gap */

        /* —— 视频数据命令头 + 数据：单次 spi_write；保证单 CS ≥ 320B（行的整数倍）
        Data command header + payload: single spi_write; guarantee single-CS ≥ 320B (multiples of a row) —— */
        uint8_t *tx_buf = data->tx_buf_bulk;
        tx_buf[0]       = HLS12VGA_LCD_DATA_REG;
        tx_buf[1]       = (HLS12VGA_LCD_CMD_REG >> 16) & 0xFF;
        tx_buf[2]       = (HLS12VGA_LCD_CMD_REG >> 8) & 0xFF;
        tx_buf[3]       = HLS12VGA_LCD_CMD_REG & 0xFF;

        const size_t data_bytes = sub_lines * dst_stride; /* 320B 或 640B；320B or 640B */
        const size_t total_sent = 4 + data_bytes;         /* +4B 头；plus 4B header */
        ret = hls12vga_transmit_all(dev, tx_buf, total_sent, 1);
        if (ret)
        {
            LOG_ERR("SPI transmit failed: %d", ret);
            return ret;
        }

        line_off += sub_lines;
        remaining -= sub_lines;
    }
    uint32_t t1 = k_uptime_get_32();
    if ((g_frame_count & 0x7) == 0)
    {  
        LOG_INF("hls12vga_transmit_all = [%u]ms, line[%u], bytes[%u]B ", t1 - t0, line_off, line_off * dst_stride + 4);
    }
    g_frame_count++;
    return 0;
}

#endif

static int hls12vga_read(struct device *dev, int x, int y, const struct display_buffer_descriptor *desc, void *buf)
{
    return -ENOTSUP;
}
int hls12vga_set_brightness(uint8_t brightness)
{
    LOG_INF("set Brightness: [%d]", brightness);
    const uint8_t reg_val[] = {1, 4, 7, 10, 14, 18, 22, 27, 32, 40};
    uint8_t       level     = 0;
    uint8_t       cmd[3]    = {0};
    if (brightness > 9)
    {
        LOG_ERR("level error %d", brightness);
        level = 40;
    }
    else
    {
        level = reg_val[brightness % 10];
    }
    cmd[0] = LCD_WRITE_ADDRESS;
    cmd[1] = HLS12VGA_LCD_SB_REG;
    cmd[2] = level;
    hls12vga_transmit_all(dev_hls12vga, cmd, sizeof(cmd), 1);
    return 0;
}
/**
 * @Description: Set display orientation
 * @param value: Orientation value.
 *               0x10: Vertical mirror
 *               0x00: Normal display
 *               0x08: Horizontal mirror
 *               0x18: Horizontal + vertical mirror
 * @return: 0 on success, negative value on error
 */
int hls12vga_set_mirror(const uint8_t value)
{
    uint8_t cmd[3] = {0};
    cmd[0]         = LCD_WRITE_ADDRESS;
    cmd[1]         = HLS12VGA_LCD_MIRROR_REG;
    cmd[2]         = value;
    int err        = hls12vga_transmit_all(dev_hls12vga, cmd, sizeof(cmd), 1);
    return err;
}
static void *hls12vga_get_framebuffer(struct device *dev)
{
    return NULL;
}
/**
 * @brief Retrieves the capabilities of the display device
 * @param dev Display device handle
 * @param cap Pointer to the display device capability structure
 */
static int hls12vga_get_capabilities(struct device *dev, struct display_capabilities *cap)
{
    const hls12vga_config *cfg = (hls12vga_config *)dev->config;
    memset(cap, 0, sizeof(struct display_capabilities));
    cap->x_resolution = cfg->screen_width;
    cap->y_resolution = cfg->screen_height;
    cap->screen_info  = SCREEN_INFO_MONO_MSB_FIRST | SCREEN_INFO_X_ALIGNMENT_WIDTH;

    cap->current_pixel_format    = PIXEL_FORMAT_MONO01;
    cap->supported_pixel_formats = PIXEL_FORMAT_MONO01;
    // cap->current_pixel_format = PIXEL_FORMAT_MONO10;
    // cap->supported_pixel_formats = PIXEL_FORMAT_MONO10;
    cap->current_orientation = DISPLAY_ORIENTATION_NORMAL;
    return 0;
}
void hls12vga_power_on(void)
{
    LOG_INF("bsp_lcd_power_on");
    const hls12vga_config *cfg = (hls12vga_config *)dev_hls12vga->config;
    pm_device_action_run(dev_hls12vga, PM_DEVICE_ACTION_RESUME);
    k_msleep(50);
    gpio_pin_set_dt(&cfg->reset, 1);  // reset high
    k_msleep(1);
    gpio_pin_set_dt(&cfg->v0_9, 1);  // v0.9 high
    k_msleep(5);
    gpio_pin_set_dt(&cfg->v1_8, 1);  // v1.8 high
    k_msleep(200);
    gpio_pin_set_dt(&cfg->reset, 0);  // reset low
    k_msleep(50);                     // 等待复位完成; Wait for reset to complete
    gpio_pin_set_dt(&cfg->reset, 1);  // reset high
    k_msleep(200);
}

void hls12vga_power_off(void)
{
    LOG_INF("bsp_lcd_power_off");
    const hls12vga_config *cfg = (hls12vga_config *)dev_hls12vga->config;
    // display_blanking_on(dev_hls12vga);
    // spi_release_dt(&cfg->spi);
    gpio_pin_set_dt(&cfg->left_cs, 1);
    gpio_pin_set_dt(&cfg->right_cs, 1);
    pm_device_action_run(dev_hls12vga, PM_DEVICE_ACTION_SUSPEND);

    gpio_pin_set_dt(&cfg->vcom, 0);
    k_msleep(10);
    gpio_pin_set_dt(&cfg->v1_8, 0);
    k_msleep(10);
    gpio_pin_set_dt(&cfg->v0_9, 0);
}

int hls12vga_clear_screen(bool color_on)
{
    const hls12vga_config *cfg    = dev_hls12vga->config;
    hls12vga_data         *data   = dev_hls12vga->data;
    const uint16_t         width  = cfg->screen_width; /* 640 */
    const uint16_t         height = SCREEN_HEIGHT;

    uint8_t *tx_buf          = data->tx_buf_bulk;
    uint16_t lines_per_batch = MAX_LINES_PER_WRITE;
    uint16_t total_lines     = height;

    uint8_t fill_byte = color_on ? 0xFF : 0x00;

    for (uint16_t y = 0; y < total_lines; y += lines_per_batch)
    {
        uint16_t batch_lines = MIN(lines_per_batch, total_lines - y);

        // Build data command (LCD Locality + Address)
        hls12vga_write_multiple_rows_cmd(dev_hls12vga, y, y + batch_lines - 1);
        tx_buf[0] = HLS12VGA_LCD_DATA_REG;
        tx_buf[1] = (HLS12VGA_LCD_CMD_REG >> 16) & 0xFF;
        tx_buf[2] = (HLS12VGA_LCD_CMD_REG >> 8) & 0xFF;
        tx_buf[3] = HLS12VGA_LCD_CMD_REG & 0xFF;

        memset(&tx_buf[4], fill_byte, batch_lines * (width / 2));
        int ret = hls12vga_transmit_all(dev_hls12vga, tx_buf, 4 + batch_lines * (width / 2), 1);
        if (ret != 0)
        {
            LOG_INF("hls12vga_transmit_all failed! (%d)", ret);
            return ret;
        }
    }
    return 0;
}
void hls12vga_open_display(void)
{
    const hls12vga_config *cfg = dev_hls12vga->config;
    gpio_pin_set_dt(&cfg->vcom, 1);  // 开启显示; open display
}
/**
 * @brief Initializes the device
 * @param dev Device structure
 */
static int hls12vga_init(const struct device *dev)
{
    hls12vga_config *cfg  = (hls12vga_config *)dev->config;
    hls12vga_data   *data = (hls12vga_data *)dev->data;
    int              ret;
    if (!spi_is_ready_dt(&cfg->spi))
    {
        LOG_ERR("custom_hls12vga_init SPI device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->left_cs))
    {
        LOG_ERR("GPIO left cs device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->right_cs))
    {
        LOG_ERR("GPIO right cs device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->reset))
    {
        LOG_ERR("GPIO reset device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->vcom))
    {
        LOG_ERR("GPIO vcom device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->v1_8))
    {
        LOG_ERR("GPIO v0_8 device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->v0_9))
    {
        LOG_ERR("GPIO v0_9 device not ready");
        return -ENODEV;
    }
    /****************************************************************** */
    ret = gpio_pin_configure_dt(&cfg->left_cs, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("cs display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->left_cs, 1);
    if (ret < 0)
    {
        LOG_ERR("left_cs Enable display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_configure_dt(&cfg->right_cs, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("right_cs display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->right_cs, 1);
    if (ret < 0)
    {
        LOG_ERR("right_cs Enable display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_configure_dt(&cfg->reset, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("Reset display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->reset, 1);
    if (ret < 0)
    {
        LOG_ERR("reset Enable display failed! (%d)", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&cfg->vcom, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("vcom display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->vcom, 0);
    if (ret < 0)
    {
        LOG_ERR("vcom Enable display failed! (%d)", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&cfg->v1_8, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("v1_8 display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->v1_8, 0);
    if (ret < 0)
    {
        LOG_ERR("v1_8 Enable display failed! (%d)", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&cfg->v0_9, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("v0_9 display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->v0_9, 0);
    if (ret < 0)
    {
        LOG_ERR("v0_9 Enable display failed! (%d)", ret);
        return ret;
    }
    hls12vga_init_sem_give();
    data->initialized = true;
    LOG_INF("Display initialized");
    return 0;
}
/********************************************************************************/

/* 驱动API注册; device API registration */
// static const struct display_driver_api hls12vga_driver_api =
static DEVICE_API(display, hls12vga_api) = {
    .blanking_on      = hls12vga_blanking_on,
    .blanking_off     = hls12vga_blanking_off,
    .write            = hls12vga_write,
    .read             = hls12vga_read,
    .set_brightness   = hls12vga_set_brightness,    // set brightness
    .get_framebuffer  = hls12vga_get_framebuffer,   // get framebuffer
    .get_capabilities = hls12vga_get_capabilities,  // get capabilities
};
#define CUSTOM_HLS12VGA_DEFINE(inst)                                                                                    \
    static uint8_t         hls12vga_bulk_tx_buffer_##inst[4 + (MAX_LINES_PER_WRITE * (DT_INST_PROP(inst, width) / 2))]; \
    static hls12vga_config hls12vga_config_##inst = {                                                                   \
        .spi           = SPI_DT_SPEC_INST_GET(inst, SPI_OP_MODE_MASTER | SPI_TRANSFER_MSB | SPI_WORD_SET(8U), 0U),      \
        .left_cs       = GPIO_DT_SPEC_INST_GET(inst, left_cs_gpios),                                                    \
        .right_cs      = GPIO_DT_SPEC_INST_GET(inst, right_cs_gpios),                                                   \
        .reset         = GPIO_DT_SPEC_INST_GET(inst, reset_gpios),                                                      \
        .vcom          = GPIO_DT_SPEC_INST_GET(inst, vcom_gpios),                                                       \
        .v1_8          = GPIO_DT_SPEC_INST_GET(inst, v1_8_gpios),                                                       \
        .v0_9          = GPIO_DT_SPEC_INST_GET(inst, v0_9_gpios),                                                       \
        .screen_width  = DT_INST_PROP(inst, width),                                                                     \
        .screen_height = DT_INST_PROP(inst, height),                                                                    \
    };                                                                                                                  \
                                                                                                                        \
    static hls12vga_data hls12vga_data_##inst = {                                                                       \
        .tx_buf_bulk   = hls12vga_bulk_tx_buffer_##inst,                                                                \
        .screen_width  = DT_INST_PROP(inst, width),                                                                     \
        .screen_height = DT_INST_PROP(inst, height),                                                                    \
        .initialized   = false,                                                                                         \
    };                                                                                                                  \
                                                                                                                        \
    DEVICE_DT_INST_DEFINE(inst, hls12vga_init, NULL, &hls12vga_data_##inst, &hls12vga_config_##inst, POST_KERNEL,       \
                          CONFIG_DISPLAY_INIT_PRIORITY, &hls12vga_api);

/* 为每个状态为"okay"的设备树节点创建实例; Create instance for each device tree node with status "okay" */
DT_INST_FOREACH_STATUS_OKAY(CUSTOM_HLS12VGA_DEFINE)