/*
 * @Author       : Cole
 * @Date         : 2025-07-28 11:31:02
 * @LastEditTime : 2025-08-20 17:36:38
 * @FilePath     : a6m_0011.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "a6m_0011.h"

#include <stdio.h>
#include <zephyr/device.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/types.h>

#define LOG_MODULE_NAME CUSTOM_A6M_0011
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define SCREEN_WIDTH  640
#define SCREEN_HEIGHT 480
#define DT_DRV_COMPAT zephyr_custom_a6m_0011

#if DT_NUM_INST_STATUS_OKAY(DT_DRV_COMPAT) == 0
#warning "Custom a6m_0011 driver enabled without any devices"
#endif
const struct device *dev_a6m_0011 = DEVICE_DT_GET(DT_INST(0, DT_DRV_COMPAT));
static K_SEM_DEFINE(a6m_0011_init_sem, 0, 1);

#define LVGL_TICK_MS 5
// The maximum number of rows written each time can be adjusted according to config lv z vdb size;
#define MAX_LINES_PER_WRITE 48  // 每次写入的最大行数; The maximum number of rows written each time
void a6m_0011_init_sem_give(void)
{
    k_sem_give(&a6m_0011_init_sem);
}

int a6m_0011_init_sem_take(void)
{
    return k_sem_take(&a6m_0011_init_sem, K_FOREVER);
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

    const a6m_0011_config *cfg = dev->config;
    uint8_t                tx[3];
    tx[0]                    = A6M_0011_LCD_WRITE_ADDRESS;
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
 * @param mode  移动模式 ；mobility pattern
 * @param steps 偏移步数，0～2（每步相当于 8 像素）；Offset steps: 0 to 2 (each step is equivalent to 8 pixels)
 * @return 0 成功，负值错误码；0 Success, negative error code
 */
int a6m_0011_set_shift(move_mode mode, uint8_t steps)
{
    /* 1. 参数校验：steps 只能是 0、1 或 2；Parameter verification: The value of "steps" can only be 0, 1, or 2. */
    if (steps > 2U || mode >= MOVE_MAX)
    {
        LOG_ERR("Invalid parameters: mode=%d, steps=%d", mode, steps);
        return -1;
    }

    /* 2. 选寄存器和左右通道的基准值；Select the reference values for the register and the left and right channels */
    uint8_t reg;
    uint8_t val_l, val_r;

    switch (mode)
    {
        case MOVE_DEFAULT:
            reg = A6M_0011_LCD_HD_REG; /* HD/VD 随便写，写两次都覆盖; HD/VD can be written freely. Writing twice will
                                          overwrite the previous content. */
            val_l = A6M_0011_SHIFT_CENTER;
            val_r = A6M_0011_SHIFT_CENTER;
            break;

        case MOVE_RIGHT:
            reg   = A6M_0011_LCD_HD_REG;
            val_l = A6M_0011_SHIFT_CENTER + steps; /* 左机向右；Left aircraft turns right */
            val_r = A6M_0011_SHIFT_CENTER - steps; /* 右机向左；The right machine is moving to the left.*/
            break;

        case MOVE_LEFT:
            reg   = A6M_0011_LCD_HD_REG;
            val_l = A6M_0011_SHIFT_CENTER - steps; /* 左机向左；Left engine on the left side is pointing to the left. */
            val_r = A6M_0011_SHIFT_CENTER + steps; /* 右机向右；The right machine is moving to the right. */
            break;

        case MOVE_UP:
            reg   = A6M_0011_LCD_VD_REG;
            val_l = A6M_0011_SHIFT_CENTER
                    - steps; /* 上移，左右同步；Move upwards, synchronously on the left and right. */
            val_r = A6M_0011_SHIFT_CENTER - steps;
            break;

        case MOVE_DOWN:
            reg   = A6M_0011_LCD_VD_REG;
            val_l = A6M_0011_SHIFT_CENTER + steps; /* 下移，左右同步；Move downward, synchronize left and right */
            val_r = A6M_0011_SHIFT_CENTER + steps;
            break;

        default:
            return -EINVAL;
    }

    const a6m_0011_config *cfg  = dev_a6m_0011->config;
    int                    err1 = write_reg_side(dev_a6m_0011, &cfg->left_cs, reg, val_l);
    int                    err2 = write_reg_side(dev_a6m_0011, &cfg->right_cs, reg, val_r);

    LOG_INF("set_shift: mode=%d, steps=%d → reg=0x%02X, L=0x%02X, R=0x%02X", mode, steps, reg, val_l, val_r);

    return err1 ?: err2;
}

static int a6m_0011_transmit_all(const struct device *dev, const uint8_t *data, size_t size, int retries)
{
    if (!dev || !data || size == 0)
    {
        return -EINVAL;
    }
    int                    err    = -1;
    const a6m_0011_config *cfg    = dev->config;
    struct spi_buf         tx_buf = {
                .buf = data,
                .len = size,
    };
    struct spi_buf_set tx = {
        .buffers = &tx_buf,
        .count   = 1,
    };

    for (int i = 0; i <= retries; i++)
    {
        gpio_pin_set_dt(&cfg->right_cs, 1);
        gpio_pin_set_dt(&cfg->left_cs, 0);
        err = spi_write_dt(&cfg->spi, &tx);
        gpio_pin_set_dt(&cfg->left_cs, 1);
        if (err == 0)
        {
            // return 0;
        }
        gpio_pin_set_dt(&cfg->right_cs, 0);
        err = spi_write_dt(&cfg->spi, &tx);
        gpio_pin_set_dt(&cfg->right_cs, 1);
        if (err == 0)
        {
            return 0;
        }
        k_msleep(1);
        LOG_INF("SPI write failed (attempt %d/%d): %d", i + 1, retries + 1, err);
    }
    return err;
}

void a6m_0011_write_multiple_rows_cmd(const struct device *dev, uint16_t start_line, uint16_t end_line)
{
    uint8_t reg[8] = {0};
    reg[0]         = A6M_0011_LCD_DATA_REG;
    reg[1]         = (A6M_0011_LCD_LOCALITY_REG >> 16) & 0xff;
    reg[2]         = (A6M_0011_LCD_LOCALITY_REG >> 8) & 0xff;
    reg[3]         = A6M_0011_LCD_LOCALITY_REG & 0xff;
    reg[4]         = (start_line >> 8) & 0xff;
    reg[5]         = start_line & 0xff;
    reg[6]         = (end_line >> 8) & 0xff;
    reg[7]         = end_line & 0xff;
    a6m_0011_transmit_all(dev, reg, sizeof(reg), 1);
}

static int a6m_0011_blanking_on(struct device *dev)
{
    return 0;
}

static int a6m_0011_blanking_off(struct device *dev)
{
    return 0;
}

#if 1
static int a6m_0011_write(const struct device *dev, const uint16_t x, const uint16_t y,
                          const struct display_buffer_descriptor *desc, const void *buf)
{
    const a6m_0011_config *cfg    = dev->config;
    a6m_0011_data         *data   = dev->data;
    const uint16_t         width  = desc->width;
    const uint16_t         height = desc->height;
    const uint16_t         pitch  = desc->pitch;
    int                    ret    = 0;
    // if (x != 0 || pitch != cfg->screen_width || width != cfg->screen_width || height > MAX_LINES_PER_WRITE)
    if (y + height > cfg->screen_height)
    {
        return -ENOTSUP;
    }

    const uint8_t *src        = (const uint8_t *)buf;
    uint8_t       *dst        = data->tx_buf_bulk + 4;
    const uint16_t src_stride = (width + 7) / 8;
    const uint16_t dst_stride = cfg->screen_width;
    // 每像素1bit展开为 0x00 / 0xFF
    // Expand 1bit per pixel to 0x00 / 0xFF
    for (uint16_t row = 0; row < height; row++)  // 遍历每一行；Iterate over each row
    {
        const uint8_t *src_row = src + row * src_stride;  // 源缓冲区当前行地址；Current row address in source buffer
        uint8_t *dst_row = dst + row * dst_stride;  // 目标缓冲区当前行地址；Current row address in destination buffer

        for (uint16_t col = 0; col < width; col++)  // 处理一行数据像素点；Process each pixel in the row
        {
            uint8_t byte = src_row[col / 8];  // 读取LVGL源数据字节(1b = 1像素)；Read LVGL source data byte (1b = 1 pixel)
            uint8_t bit = (byte >> (7 - (col % 8))) & 0x01;  // 读取1bit数据 按照MSB位序读取；Read 1bit data in MSB order
            dst_row[col] = bit ? BACKGROUND_COLOR : COLOR_BRIGHT;  // 亮：0xFF，暗：0x00；Bright: 0xFF, Dark: 0x00
            // dst_row[col] = bit ? COLOR_BRIGHT : BACKGROUND_COLOR; // 亮：0xFF，暗：0x00；Bright: 0xFF, Dark: 0x00
        }
    }
    a6m_0011_write_multiple_rows_cmd(dev, y, y + height - 1);

    uint8_t *tx_buf = data->tx_buf_bulk;
    tx_buf[0]       = A6M_0011_LCD_DATA_REG;
    tx_buf[1]       = (A6M_0011_LCD_CMD_REG >> 16) & 0xFF;
    tx_buf[2]       = (A6M_0011_LCD_CMD_REG >> 8) & 0xFF;
    tx_buf[3]       = A6M_0011_LCD_CMD_REG & 0xFF;

    ret = a6m_0011_transmit_all(dev, tx_buf, 4 + height * dst_stride, 1);
    if (ret != 0)
    {
        LOG_ERR("SPI transmit failed: %d", ret);  // SPI传输失败；SPI transmission failed
    }
    return ret;
}
#endif

static int a6m_0011_read(struct device *dev, int x, int y, const struct display_buffer_descriptor *desc, void *buf)
{
    return -1;
}
/**\
 * @Description: set brightness
 * @param brightness: brightness level (0x00 to 0x3A)
 * @return: 0 success, negative error code
 */
int a6m_0011_set_brightness(uint8_t brightness)
{
    LOG_INF("set Brightness: [%d]", brightness);
    uint8_t cmd[3] = {0};
    uint8_t level  = 0;
    if (brightness > 0x3A)
    {
        LOG_ERR("level error %d", brightness);
        level = 0x3A;  // 最大亮度值；maximum brightness value
    }
    else
    {
        level = brightness;
    }
    cmd[0] = A6M_0011_LCD_WRITE_ADDRESS;
    cmd[1] = A6M_0011_LCD_SB_REG;
    cmd[2] = level;
    a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);
    return 0;
}
#if 1
int a6m_0011_read_reg(uint8_t reg)
{
    LOG_INF("read reg: %02X", reg);
    uint8_t cmd[3]                     = {0};
    cmd[0]                             = A6M_0011_LCD_READ_ADDRESS;
    cmd[1]                             = reg;
    cmd[2]                             = 0;
    uint8_t                rx_buff[10] = {0};
    const a6m_0011_config *cfg         = dev_a6m_0011->config;
    struct spi_buf         buf         = {
                        .buf = cmd,
                        .len = sizeof(cmd),
    };
    struct spi_buf_set tx_set = {
        .buffers = &buf,
        .count   = 1,
    };

    struct spi_buf rx_buf = {
        .buf = rx_buff,
        .len = sizeof(rx_buff),
    };
    struct spi_buf_set rx_set = {
        .buffers = &rx_buf,
        .count   = 1,
    };

    gpio_pin_set_dt(&cfg->right_cs, 0);
    gpio_pin_set_dt(&cfg->left_cs, 0);
    spi_transceive_dt(&cfg->spi, &tx_set, &rx_set);

    gpio_pin_set_dt(&cfg->right_cs, 1);
    gpio_pin_set_dt(&cfg->left_cs, 1);
    LOG_INF("read reg: %02X, value: 0x%02X 0x%02X 0x%02X", reg, rx_buff[0], rx_buff[1], rx_buff[2]);
    return 0;
}

int a6m_0011_write_reg(uint8_t reg, uint8_t param)
{
    LOG_INF("bspal_write_register reg:0x%02x, param:0x%02x", reg, param);
    uint8_t cmd[3] = {0};
    cmd[0]         = A6M_0011_LCD_WRITE_ADDRESS;
    cmd[1]         = reg;
    cmd[2]         = param;
    a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);
    return 0;
}
#endif

int a6m_0011_set_mirror(mirror_mode_t mode)
{
    if (mode > MIRROR_BOTH)
    {
        LOG_ERR("Invalid mirror mode: %d", mode);
        return -1;
    }
    uint8_t cmd[3];
    int     err = 0;
    switch (mode)
    {
        case MIRROR_NORMAL:
            // 0: 取消水平和垂直；cancel horizontal and vertical
            cmd[0] = A6M_0011_LCD_WRITE_ADDRESS;
            cmd[1] = A6M_0011_LCD_HORIZONTAL_MIRROR_REG;
            cmd[2] = 0x00;
            err    = a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);

            cmd[1] = A6M_0011_LCD_VERTICAL_MIRROR_REG;
            cmd[2] = 0x00;
            err |= a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);
            break;

        case MIRROR_HORZ:
            // 1: 仅水平翻转；only horizontal flip
            cmd[0] = A6M_0011_LCD_WRITE_ADDRESS;
            cmd[1] = A6M_0011_LCD_HORIZONTAL_MIRROR_REG;
            cmd[2] = A6M_0011_MIRROR_ENABLE;
            err    = a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);
            break;

        case MIRROR_VERT:
            // 2: 仅垂直翻转；only vertical flip
            cmd[0] = A6M_0011_LCD_WRITE_ADDRESS;
            cmd[1] = A6M_0011_LCD_VERTICAL_MIRROR_REG;
            cmd[2] = A6M_0011_MIRROR_ENABLE;
            err    = a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);
            break;

        case MIRROR_BOTH:
            // 3: 水平 + 垂直；horizontal + vertical
            cmd[0] = A6M_0011_LCD_WRITE_ADDRESS;
            cmd[1] = A6M_0011_LCD_HORIZONTAL_MIRROR_REG;
            cmd[2] = A6M_0011_MIRROR_ENABLE;
            err    = a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);

            cmd[1] = A6M_0011_LCD_VERTICAL_MIRROR_REG;
            cmd[2] = A6M_0011_MIRROR_ENABLE;
            err |= a6m_0011_transmit_all(dev_a6m_0011, cmd, sizeof(cmd), 1);
            break;
        default:
            LOG_ERR("Unsupported mirror mode: %d", mode);
            return -1;
    }

    LOG_INF("set_mirror: mode=%d, err=%d", mode, err);
    return err;
}

static void *a6m_0011_get_framebuffer(struct device *dev)
{
    return NULL;
}
/***
 * @brief 获取显示设备的能力；Retrieves the capabilities of the display device
 * @param dev: 显示设备句柄；Display device handle
 * @param cap: 显示设备显示结构体；Display device capability structure
 */
static int a6m_0011_get_capabilities(struct device *dev, struct display_capabilities *cap)
{
    const a6m_0011_config *cfg = (a6m_0011_config *)dev->config;
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
void a6m_0011_power_on(void)
{
    LOG_INF("bsp_lcd_power_on");
    const a6m_0011_config *cfg = (a6m_0011_config *)dev_a6m_0011->config;
    pm_device_action_run(dev_a6m_0011, PM_DEVICE_ACTION_RESUME);
    k_msleep(50);
    // gpio_pin_set_dt(&cfg->v1_8, 1); // v1.8 high
    gpio_pin_set_dt(&cfg->v0_9, 1);  // v1.8 high
    k_msleep(10);
    // gpio_pin_set_dt(&cfg->v0_9, 1); // v0.9 high
    gpio_pin_set_dt(&cfg->v1_8, 1);  // v0.9 high
    k_msleep(300);
}

void a6m_0011_power_off(void)
{
    LOG_INF("bsp_lcd_power_off");
    const a6m_0011_config *cfg = (a6m_0011_config *)dev_a6m_0011->config;
    // display_blanking_on(dev_a6m_0011);
    // spi_release_dt(&cfg->spi);
    gpio_pin_set_dt(&cfg->left_cs, 1);
    gpio_pin_set_dt(&cfg->right_cs, 1);
    pm_device_action_run(dev_a6m_0011, PM_DEVICE_ACTION_SUSPEND);

    gpio_pin_set_dt(&cfg->vcom, 0);
    k_msleep(10);
    gpio_pin_set_dt(&cfg->v0_9, 0);
    k_msleep(10);
    gpio_pin_set_dt(&cfg->v1_8, 0);
}
static void lvgl_tick_cb(struct k_timer *timer)
{
    // LOG_INF("lvgl_tick_cb");
    lv_tick_inc(K_MSEC(LVGL_TICK_MS));
}
int a6m_0011_clear_screen(bool color_on)
{
    const a6m_0011_config *cfg  = dev_a6m_0011->config;
    a6m_0011_data         *data = dev_a6m_0011->data;

    const uint16_t width = cfg->screen_width;
    // const uint16_t height = cfg->screen_height;
    const uint16_t height = SCREEN_HEIGHT;

    uint8_t *tx_buf          = data->tx_buf_bulk;
    uint16_t lines_per_batch = MAX_LINES_PER_WRITE;
    uint16_t total_lines     = height;

    uint8_t fill_byte = color_on ? 0xFF : 0x00;

    for (uint16_t y = 0; y < total_lines; y += lines_per_batch)
    {
        uint16_t batch_lines = MIN(lines_per_batch, total_lines - y);

        a6m_0011_write_multiple_rows_cmd(dev_a6m_0011, y, y + batch_lines - 1);
        tx_buf[0] = A6M_0011_LCD_DATA_REG;
        tx_buf[1] = (A6M_0011_LCD_CMD_REG >> 16) & 0xFF;
        tx_buf[2] = (A6M_0011_LCD_CMD_REG >> 8) & 0xFF;
        tx_buf[3] = A6M_0011_LCD_CMD_REG & 0xFF;

        memset(&tx_buf[4], fill_byte, batch_lines * width);
        int ret = a6m_0011_transmit_all(dev_a6m_0011, tx_buf, 4 + batch_lines * width, 1);
        if (ret != 0)
        {
            LOG_INF("a6m_0011_transmit_all failed! (%d)", ret);
            return ret;
        }
    }
    return 0;
}
void a6m_0011_open_display(void)
{
    const a6m_0011_config *cfg = dev_a6m_0011->config;
    gpio_pin_set_dt(&cfg->vcom, 1);  // 开启显示；Enable display
}

static int a6m_0011_init(const struct device *dev)
{
    a6m_0011_config *cfg  = (a6m_0011_config *)dev->config;
    a6m_0011_data   *data = (a6m_0011_data *)dev->data;
    int              ret;
    if (!spi_is_ready_dt(&cfg->spi))
    {
        LOG_ERR("custom_a6m_0011_init SPI device not ready");
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
    ret = gpio_pin_configure_dt(&cfg->reset, GPIO_INPUT);
    if (ret < 0)
    {
        LOG_ERR("Reset display failed! (%d)", ret);
        return ret;
    }
    // ret = gpio_pin_set_dt(&cfg->reset, 1);
    // if (ret < 0)
    // {
    // 	LOG_ERR("reset Enable display failed! (%d)", ret);
    // 	return ret;
    // }

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
    a6m_0011_init_sem_give();
#if 0
	/************************************************************* */
	a6m_0011_power_on();
	// k_timer_init(&data->lvgl_tick, lvgl_tick_cb, NULL);
	// k_timer_start(&data->lvgl_tick, K_NO_WAIT, K_MSEC(LVGL_TICK_MS));
#endif
    data->initialized = true;

    LOG_INF("Display initialized");
    return 0;
}
/********************************************************************************/

/* 驱动API注册 */
// static const struct display_driver_api a6m_0011_driver_api =
static DEVICE_API(display, a6m_0011_api) = {
    .blanking_on      = a6m_0011_blanking_on,
    .blanking_off     = a6m_0011_blanking_off,
    .write            = a6m_0011_write,
    .read             = a6m_0011_read,
    .set_brightness   = a6m_0011_set_brightness,    // 设置亮度；Set brightness
    .get_framebuffer  = a6m_0011_get_framebuffer,   // 获取帧缓冲区；Get framebuffer
    .get_capabilities = a6m_0011_get_capabilities,  // 获取显示能力；Get display capabilities
};
#define CUSTOM_a6m_0011_DEFINE(inst)                                                                               \
    /* 静态数组定义 */                                                                                             \
    static uint8_t         a6m_0011_bulk_tx_buffer_##inst[4 + MAX_LINES_PER_WRITE * DT_INST_PROP(inst, width)];    \
    static a6m_0011_config a6m_0011_config_##inst = {                                                              \
        .spi           = SPI_DT_SPEC_INST_GET(inst, SPI_OP_MODE_MASTER | SPI_TRANSFER_MSB | SPI_WORD_SET(8U), 0U), \
        .left_cs       = GPIO_DT_SPEC_INST_GET(inst, left_cs_gpios),                                               \
        .right_cs      = GPIO_DT_SPEC_INST_GET(inst, right_cs_gpios),                                              \
        .reset         = GPIO_DT_SPEC_INST_GET(inst, reset_gpios),                                                 \
        .vcom          = GPIO_DT_SPEC_INST_GET(inst, vcom_gpios),                                                  \
        .v1_8          = GPIO_DT_SPEC_INST_GET(inst, v1_8_gpios),                                                  \
        .v0_9          = GPIO_DT_SPEC_INST_GET(inst, v0_9_gpios),                                                  \
        .screen_width  = DT_INST_PROP(inst, width),                                                                \
        .screen_height = DT_INST_PROP(inst, height),                                                               \
    };                                                                                                             \
                                                                                                                   \
    static a6m_0011_data a6m_0011_data_##inst = {                                                                  \
        .tx_buf_bulk   = a6m_0011_bulk_tx_buffer_##inst,                                                           \
        .screen_width  = DT_INST_PROP(inst, width),                                                                \
        .screen_height = DT_INST_PROP(inst, height),                                                               \
        .initialized   = false,                                                                                    \
    };                                                                                                             \
                                                                                                                   \
    DEVICE_DT_INST_DEFINE(inst, a6m_0011_init, NULL, &a6m_0011_data_##inst, &a6m_0011_config_##inst, POST_KERNEL,  \
                          CONFIG_DISPLAY_INIT_PRIORITY, &a6m_0011_api);

/* 为每个状态为"okay"的设备树节点创建实例；Create an instance for each device tree node with the status "okay"*/
DT_INST_FOREACH_STATUS_OKAY(CUSTOM_a6m_0011_DEFINE)