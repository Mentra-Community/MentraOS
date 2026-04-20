/*
 * @Author       : Cole
 * @Date         : 2026-03-27 17:34:41
 * @LastEditTime : 2026-03-31 14:45:32
 * @FilePath     : mos_iqs7211a.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2026
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_iqs7211a.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <zephyr/device.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(mos_iqs7211a, LOG_LEVEL_INF);

#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>

/* IQS node -> its parent I2C bus node (still i2c3). */
#define IQS_NODE DT_ALIAS(iqs7211a)
#define I2C_NODE DT_PARENT(IQS_NODE)
#define IQS_RDY_NODE DT_PATH(zephyr_user)

#if !DT_NODE_EXISTS(IQS_RDY_NODE) || !DT_NODE_HAS_PROP(IQS_RDY_NODE, iqs7211a_rdy_gpios)
#error "IQS7211A requires devicetree: zephyr,user property iqs7211a_rdy-gpios (RDY GPIO)."
#endif

static const struct device *i2c_dev = NULL;
static bool s_iqs_initialized = false;

/* RDY is active-low (datasheet): inactive=high, asserted=low → trigger on falling edge to catch new window. */
#define IQS_RDY_GPIO_INT (GPIO_INT_EDGE_FALLING)

/* Forward declarations (used by RDY work handler) */
static int iqs_force_comm_window(void);
static int iqs_read_block16(uint16_t start_reg, uint16_t *out_words, size_t words_count);
static int iqs_read_reg16(uint16_t reg, uint16_t *value);
static void iqs_try_fill_version_cache(void);
static int iqs_setup_rdy_interrupt(void);
static int iqs_write_block8(uint8_t start_reg, const uint8_t *data, size_t len);

static const struct gpio_dt_spec s_iqs_rdy_gpio = GPIO_DT_SPEC_GET(IQS_RDY_NODE, iqs7211a_rdy_gpios);
static struct gpio_callback s_iqs_rdy_cb;
static struct k_work s_iqs_rdy_work;
static atomic_t s_iqs_cache_valid = ATOMIC_INIT(0);
static uint16_t s_last_gestures = 0;
static uint16_t s_last_info_flags = 0;
static uint16_t s_last_finger1_x = 0;
static uint16_t s_last_finger1_y = 0;
static uint16_t s_last_rel_x = 0;
static uint16_t s_last_rel_y = 0;
static atomic_t s_rdy_enabled = ATOMIC_INIT(0);
static atomic_t s_rdy_isr_count = ATOMIC_INIT(0);
static atomic_t s_rdy_work_count = ATOMIC_INIT(0);
static atomic_t s_rdy_read_ok_count = ATOMIC_INIT(0);
static atomic_t s_rdy_read_fail_count = ATOMIC_INIT(0);
static atomic_t s_rdy_filtered_count = ATOMIC_INIT(0);
static atomic_t s_rdy_gpio_subscribed = ATOMIC_INIT(0);

static mos_iqs7211a_runtime_callback_t s_runtime_callback = NULL;
static void *s_runtime_callback_user_data = NULL;

/* Product/version 0x00..0x09: filled early in RDY k_work handler (before 0x10 block; shell id/ver). */
static uint16_t s_iqs_version_words[10];
static atomic_t s_iqs_version_cache_valid = ATOMIC_INIT(0);
static atomic_t s_iqs_version_fetch_pending = ATOMIC_INIT(0);
static K_SEM_DEFINE(s_iqs_version_sem, 0, 1);

static bool iqs_word_has_invalid_byte(uint16_t w)
{
    return (((w & 0x00FFu) == 0x00EEu) || (((w >> 8) & 0x00FFu) == 0x00EEu));
}

static bool iqs_word_is_obviously_invalid(uint16_t w)
{
    /* Observed during window edges/noise: 0xFFFF or 0xFFxx.
     * Treat as invalid to keep cached state stable.
     */
    if (w == 0xFFFFu)
    {
        return true;
    }
    if ((w & 0xFF00u) == 0xFF00u)
    {
        return true;
    }
    return false;
}

/* Slide/stroke policy is handled by mos_touch_app; driver only reports raw frames. */

static void iqs_rdy_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    atomic_inc(&s_rdy_work_count);

    /* Product / version at 0x00.. must be read early in the RDY window (see iqs_try_fill_version_cache). */
    iqs_try_fill_version_cache();

    /* 7211A runtime map starts at 0x10:
     * [0]=INFO_FLAGS [1]=GESTURES [2]=REL_X [3]=REL_Y [4]=FINGER1_X [5]=FINGER1_Y
     */
    uint16_t words[6] = {0xEEEEu, 0xEEEEu, 0xEEEEu, 0xEEEEu, 0xEEEEu, 0xEEEEu};
    bool cached = false;

    /* Read IQS7211A runtime block: INFO_FLAGS..FINGER1_Y (0x10..0x15). */
    for (int attempt = 0; attempt < 6; attempt++)
    {
        /* Align with ProxFusion demo behavior:
         * - On RDY edge, first attempt should read immediately (already inside ready window).
         * - If invalid, then force/open comm window and retry with short backoff.
         */
        if (attempt > 0)
        {
            (void)iqs_force_comm_window();
            k_sleep(K_MSEC(2U + (uint32_t)(attempt - 1) * 4U));
        }

        int ret = iqs_read_block16(IQS7211A_REG_INFO_FLAGS, words, 6U);
        if (ret != 0)
        {
            atomic_inc(&s_rdy_read_fail_count);
            continue;
        }

        /* Datasheet: invalid communication returns 0xEE. This can appear as full words (0xEEEE)
         * or as partial bytes if the window closes mid-transfer (e.g., 0xFFEE).
         */
        if (iqs_word_has_invalid_byte(words[0]) || iqs_word_has_invalid_byte(words[1]))
        {
            atomic_inc(&s_rdy_filtered_count);
            continue;
        }

        /* Keep filtering strict on status words, but don't reject frame only due to X/Y edge values. */
        if (iqs_word_is_obviously_invalid(words[0]) || iqs_word_is_obviously_invalid(words[1]))
        {
            atomic_inc(&s_rdy_filtered_count);
            continue;
        }

        s_last_info_flags = words[0];
        s_last_gestures = words[1];
        s_last_rel_x = words[2];
        s_last_rel_y = words[3];
        s_last_finger1_x = words[4];
        s_last_finger1_y = words[5];
        atomic_set(&s_iqs_cache_valid, 1);
        atomic_inc(&s_rdy_read_ok_count);
        if (s_runtime_callback != NULL)
        {
            s_runtime_callback(words[1], words[0], words[4], words[5], words[2], words[3],
                               s_runtime_callback_user_data);
        }
        cached = true;
        break;
    }

    /* Final fallback: keep latest frame if status words are valid enough, even when x/y are noisy.
     * This avoids getting stuck in perpetual filtered=++ with read_ok=0.
     */
    if (!cached)
    {
        if (!iqs_word_has_invalid_byte(words[0]) && !iqs_word_has_invalid_byte(words[1])
            && !iqs_word_is_obviously_invalid(words[0]) && !iqs_word_is_obviously_invalid(words[1]))
        {
            s_last_info_flags = words[0];
            s_last_gestures = words[1];
            s_last_rel_x = words[2];
            s_last_rel_y = words[3];
            s_last_finger1_x = words[4];
            s_last_finger1_y = words[5];
            atomic_set(&s_iqs_cache_valid, 1);
            atomic_inc(&s_rdy_read_ok_count);
            if (s_runtime_callback != NULL)
            {
                s_runtime_callback(words[1], words[0], words[4], words[5], words[2], words[3],
                                   s_runtime_callback_user_data);
            }
        }
    }

    /* Re-enable interrupt after processing. */
    (void)gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, IQS_RDY_GPIO_INT);
}

static void iqs_rdy_gpio_callback(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
    ARG_UNUSED(dev);
    ARG_UNUSED(cb);
    ARG_UNUSED(pins);

    if (!atomic_get(&s_rdy_enabled))
    {
        return;
    }

    atomic_inc(&s_rdy_isr_count);
    /* Disable to avoid storming; k_work handler re-enables after I2C read. */
    (void)gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, GPIO_INT_DISABLE);
    k_work_submit(&s_iqs_rdy_work);
}

/**
 * @brief Read 16-bit word from an IQS memory map address.
 *
 * IQS ProxFusion:
 * - Data is 16-bit little-endian: byte0 (LSB) first, then byte1 (MSB).
 * - 8-bit addressing uses 1 address byte.
 * - Extended 16-bit addressing uses 2 address bytes, high-byte first.
 */
static int iqs_read_reg16(uint16_t reg, uint16_t *value)
{
    if (!value)
    {
        return -EINVAL;
    }

    uint8_t addr_buf[2];
    size_t addr_len = 0;
    if (reg <= 0xFFU)
    {
        addr_buf[0] = (uint8_t)reg;
        addr_len = 1U;
    }
    else
    {
        addr_buf[0] = (uint8_t)((reg >> 8) & 0xFFU); /* high byte first */
        addr_buf[1] = (uint8_t)(reg & 0xFFU); /* low byte second */
        addr_len = 2U;
    }

    uint8_t data[2] = {0};
    int ret = i2c_write_read(i2c_dev, IQS7211A_I2C_ADDR, addr_buf, addr_len, data, 2U);
    if (ret != 0)
    {
        LOG_ERR("iqs_read_reg16(0x%04x) failed: %d", reg, ret);
        return ret;
    }

    *value = (uint16_t)data[0] | ((uint16_t)data[1] << 8); /* little-endian word */
    return 0;
}

static bool iqs_version_word_valid(uint16_t w)
{
    if (w == 0xEEEEu || ((w & 0x00FFu) == 0x00EEu) || (((w >> 8) & 0x00FFu) == 0x00EEu))
    {
        return false;
    }
    return true;
}

/**
 * Fill 0x00.. product/version cache inside the RDY I2C window.
 *
 * Azoteq IQS7211A example reads PROD_NUM / MAJOR / MINOR (0x00..0x02) with RESTART/STOP
 * while RDY is true, *before* long streaming reads. Doing six words at 0x10 then ten
 * separate write+read transactions often misses the window; one block read from 0x00 first matches
 * the bus cadence and leaves time for the 0x10 runtime block.
 */
static void iqs_try_fill_version_cache(void)
{
    if (atomic_get(&s_iqs_version_cache_valid) && !atomic_get(&s_iqs_version_fetch_pending))
    {
        return;
    }

    uint16_t words[10];

    if (iqs_read_block16(0U, words, 10U) == 0)
    {
        bool all_ok = true;
        for (size_t i = 0U; i < 10U; i++)
        {
            if (!iqs_version_word_valid(words[i]))
            {
                all_ok = false;
                break;
            }
        }
        if (all_ok)
        {
            goto store_ok;
        }
    }

    /* Datasheet highlights 0x00..0x02; gap 0x03..0x0F may return values that fail EE checks. */
    if (iqs_read_block16(0U, words, 3U) != 0)
    {
        return;
    }
    for (size_t i = 0U; i < 3U; i++)
    {
        if (!iqs_version_word_valid(words[i]))
        {
            return;
        }
    }
    for (size_t j = 3U; j < 10U; j++)
    {
        words[j] = 0U;
    }

store_ok:
    for (size_t k = 0U; k < 10U; k++)
    {
        s_iqs_version_words[k] = words[k];
    }
    atomic_set(&s_iqs_version_cache_valid, 1);
    if (atomic_get(&s_iqs_version_fetch_pending))
    {
        atomic_set(&s_iqs_version_fetch_pending, 0);
        k_sem_give(&s_iqs_version_sem);
    }
}

static int iqs_force_comm_window(void)
{
    /* Datasheet: 0xFF can be used to force/open a communication window. */
    uint8_t cmd = IQS7211A_CMD_END_COMM;
    int ret = i2c_write(i2c_dev, &cmd, 1U, IQS7211A_I2C_ADDR);
    if (ret != 0)
    {
        return ret;
    }
    return 0;
}

static int iqs_read_block16(uint16_t start_reg, uint16_t *out_words, size_t words_count)
{
    if (!out_words || (words_count == 0U))
    {
        return -EINVAL;
    }

    if (start_reg > 0xFFU)
    {
        return -EINVAL;
    }

    if (words_count > 64U)
    {
        /* sanity cap */
        words_count = 64U;
    }

    uint8_t addr = (uint8_t)start_reg;
    uint8_t buf[2U * 64U];
    size_t read_len = 2U * words_count;

    int ret = i2c_write_read(i2c_dev, IQS7211A_I2C_ADDR, &addr, 1U, buf, read_len);
    if (ret != 0)
    {
        return ret;
    }

    for (size_t i = 0U; i < words_count; i++)
    {
        /* little-endian words: LSB first */
        out_words[i] = (uint16_t)buf[(2U * i) + 0U] | ((uint16_t)buf[(2U * i) + 1U] << 8);
    }
    return 0;
}

static int iqs_write_reg16(uint16_t reg, uint16_t value)
{
    uint8_t buf[4];
    size_t addr_len = 0U;
    size_t payload_len;

    uint8_t lsb = (uint8_t)(value & 0xFFU);
    uint8_t msb = (uint8_t)((value >> 8) & 0xFFU);

    if (reg <= 0xFFU)
    {
        buf[0] = (uint8_t)reg;
        addr_len = 1U;
    }
    else
    {
        buf[0] = (uint8_t)((reg >> 8) & 0xFFU); /* high byte first for extended addressing */
        buf[1] = (uint8_t)(reg & 0xFFU);
        addr_len = 2U;
    }

    /* Data byte order is little-endian: byte0=Lsb first, byte1=Msb next. */
    buf[addr_len + 0U] = lsb;
    buf[addr_len + 1U] = msb;
    payload_len = addr_len + 2U;

    int ret = i2c_write(i2c_dev, buf, payload_len, IQS7211A_I2C_ADDR);
    if (ret != 0)
    {
        LOG_ERR("iqs_write_reg16(0x%04x) failed: %d", reg, ret);
        return ret;
    }
    return 0;
}

static int iqs_write_block8(uint8_t start_reg, const uint8_t *data, size_t len)
{
    if ((data == NULL) || (len == 0U))
    {
        return -EINVAL;
    }

    if (len > 96U)
    {
        return -EINVAL;
    }

    uint8_t buf[1U + 96U];
    buf[0] = start_reg;
    memcpy(&buf[1], data, len);

    return i2c_write(i2c_dev, buf, len + 1U, IQS7211A_I2C_ADDR);
}

static int iqs_update_reg16(uint16_t reg, uint16_t mask, uint16_t value)
{
    uint16_t cur = 0;
    int ret = iqs_read_reg16(reg, &cur);
    if (ret != 0)
    {
        return ret;
    }

    uint16_t next = (uint16_t)((cur & ~mask) | (value & mask));
    if (next == cur)
    {
        return 0;
    }
    return iqs_write_reg16(reg, next);
}

/* Trackpad/gesture policy config is handled in mos_touch_app to reduce coupling. */

static int iqs_setup_rdy_interrupt(void)
{
    if (!gpio_is_ready_dt(&s_iqs_rdy_gpio))
    {
        return -ENODEV;
    }

    int ret = gpio_pin_configure_dt(&s_iqs_rdy_gpio, GPIO_INPUT);
    if (ret != 0)
    {
        return ret;
    }

    if (!atomic_get(&s_rdy_gpio_subscribed))
    {
        k_work_init(&s_iqs_rdy_work, iqs_rdy_work_handler);

        gpio_init_callback(&s_iqs_rdy_cb, iqs_rdy_gpio_callback, BIT(s_iqs_rdy_gpio.pin));
        ret = gpio_add_callback(s_iqs_rdy_gpio.port, &s_iqs_rdy_cb);
        if (ret != 0)
        {
            return ret;
        }
        atomic_set(&s_rdy_gpio_subscribed, 1);
    }

    atomic_set(&s_rdy_enabled, 1);
    return gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, IQS_RDY_GPIO_INT);
}

int mos_iqs7211a_init(void)
{
    i2c_dev = device_get_binding(DT_NODE_FULL_NAME(I2C_NODE));
    if (!i2c_dev)
    {
        LOG_ERR("IQS7211A: I2C Device driver not found");
        return -ENODEV;
    }

    uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
    int ret = i2c_configure(i2c_dev, i2c_cfg);
    if (ret != 0)
    {
        LOG_ERR("IQS7211A: I2C config failed: %d", ret);
        return ret;
    }

    if (!s_iqs_initialized)
    {
        /* 7211A demo-aligned startup synchronization:
         * 1) Read INFO_FLAGS (0x10)
         * 2) If reset bit is not set, request SW reset and re-check
         * 3) ACK reset via SYSTEM_CONTROL bit7 (low byte)
         * 4) Enable Event mode via CONFIG_SETTINGS bit8 (high byte bit0)
         */
        uint16_t info_flags = 0;
        int ret2 = iqs_read_reg16(IQS7211A_REG_INFO_FLAGS, &info_flags);
        if (ret2 == 0)
        {
            bool reset_occurred = !!(info_flags & 0x0080u); /* SHOW_RESET bit7 */
            if (!reset_occurred)
            {
                /* SYSTEM_CONTROL(0x50) SW_RESET = overall bit9 (high-byte bit1). */
                (void)iqs_update_reg16(IQS7211A_REG_SYSTEM_CONTROL, 0x0200u, 0x0200u);
                k_sleep(K_MSEC(100));
                (void)iqs_read_reg16(IQS7211A_REG_INFO_FLAGS, &info_flags);
            }
        }

        /* ACK reset (bit7 in low byte) and enable event mode (bit8). */
        (void)iqs_update_reg16(IQS7211A_REG_SYSTEM_CONTROL, 0x0080u, 0x0080u);
        (void)iqs_update_reg16(IQS7211A_REG_CONFIG_SETTINGS, 0x0100u, 0x0100u);

        s_iqs_initialized = true;
        LOG_INF("IQS7211A chip registers ready (7211A-class seq, addr=0x%02x)", IQS7211A_I2C_ADDR);
    }

    const bool first_rdy_setup = !atomic_get(&s_rdy_gpio_subscribed);
    ret = iqs_setup_rdy_interrupt();
    if (ret == 0 && first_rdy_setup)
    {
        LOG_INF("IQS7211A RDY GPIO armed (active-low, falling edge)");
    }
    return ret;
}

int mos_iqs7211a_read_event_states(uint16_t *prox_event_states, uint16_t *touch_event_states)
{
    if (!prox_event_states && !touch_event_states)
    {
        return -EINVAL;
    }

    /* Backward-compatible API: map to INFO_FLAGS and GESTURES from 7211A runtime block. */
    uint16_t words[2] = {0xEEEEu, 0xEEEEu};

    for (int attempt = 0; attempt < 6; attempt++)
    {
        (void)iqs_force_comm_window();
        k_sleep(K_MSEC(5U + (uint32_t)attempt * 10U));

        int ret = iqs_read_block16(IQS7211A_REG_INFO_FLAGS, words, 2U);
        if (ret != 0)
        {
            continue;
        }

        if ((words[0] == 0xEEEEu) || (words[1] == 0xEEEEu))
        {
            continue;
        }

        if (prox_event_states)
        {
            *prox_event_states = words[0]; /* INFO_FLAGS */
        }
        if (touch_event_states)
        {
            *touch_event_states = words[1]; /* GESTURES */
        }
        return 0;
    }

    if (prox_event_states)
    {
        *prox_event_states = words[0];
    }
    if (touch_event_states)
    {
        *touch_event_states = words[1];
    }
    return -EIO;
}

int mos_iqs7211a_read_events(uint16_t *events)
{
    if (!events)
    {
        return -EINVAL;
    }
    return iqs_read_reg16(IQS7211A_REG_GESTURES, events);
}

int mos_iqs7211a_is_touch_active(bool *active)
{
    uint16_t prox_st = 0;
    uint16_t touch_st = 0;
    int ret = mos_iqs7211a_read_event_states(&prox_st, &touch_st);
    if (ret != 0)
    {
        return ret;
    }

    /* Active if any gesture / event bit set in GESTURES word. */
    if (active)
    {
        *active = (touch_st != 0);
    }
    return 0;
}

int mos_iqs7211a_read_version_details(uint16_t *out_words, size_t out_words_count)
{
    if (!out_words || (out_words_count == 0U))
    {
        return -EINVAL;
    }

    /* Version 0x00..0x09 is reliable only inside the post-RDY comm window on this part;
     * shell thread cannot hit that timing — values are filled in iqs_rdy_work_handler. */
    const size_t max_words = 10U;
    size_t words = out_words_count;
    if (words > max_words)
    {
        words = max_words;
    }

    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        return ret;
    }

    if (atomic_get(&s_iqs_version_cache_valid))
    {
        for (size_t i = 0U; i < words; i++)
        {
            out_words[i] = s_iqs_version_words[i];
        }
        return 0;
    }

    atomic_set(&s_iqs_version_fetch_pending, 1);
    while (k_sem_take(&s_iqs_version_sem, K_NO_WAIT) == 0)
    {
    }

    if (atomic_get(&s_iqs_version_cache_valid))
    {
        atomic_set(&s_iqs_version_fetch_pending, 0);
        for (size_t i = 0U; i < words; i++)
        {
            out_words[i] = s_iqs_version_words[i];
        }
        return 0;
    }

    if (k_sem_take(&s_iqs_version_sem, K_SECONDS(3)) != 0)
    {
        atomic_set(&s_iqs_version_fetch_pending, 0);
        return -EIO;
    }

    if (!atomic_get(&s_iqs_version_cache_valid))
    {
        return -EIO;
    }

    for (size_t i = 0U; i < words; i++)
    {
        out_words[i] = s_iqs_version_words[i];
    }
    return 0;
}

int mos_iqs7211a_enable_rdy_interrupt(void)
{
    /* Same as full init (chip idempotent + RDY re-arm); for shell recovery after errors. */
    return mos_iqs7211a_init();
}

int mos_iqs7211a_get_last_status(uint16_t *events, uint16_t *prox, uint16_t *touch)
{
    if (!events && !prox && !touch)
    {
        return -EINVAL;
    }

    if (!atomic_get(&s_iqs_cache_valid))
    {
        return -EAGAIN;
    }
    if (events)
    {
        *events = s_last_gestures;
    }
    if (prox)
    {
        *prox = s_last_info_flags;
    }
    if (touch)
    {
        *touch = s_last_finger1_x;
    }
    return 0;
}

int mos_iqs7211a_get_last_runtime_data(uint16_t *gestures, uint16_t *info_flags, uint16_t *finger1_x,
                                       uint16_t *finger1_y, uint16_t *rel_x, uint16_t *rel_y)
{
    if (!gestures && !info_flags && !finger1_x && !finger1_y && !rel_x && !rel_y)
    {
        return -EINVAL;
    }

    if (!atomic_get(&s_iqs_cache_valid))
    {
        return -EAGAIN;
    }
    if (gestures)
    {
        *gestures = s_last_gestures;
    }
    if (info_flags)
    {
        *info_flags = s_last_info_flags;
    }
    if (finger1_x)
    {
        *finger1_x = s_last_finger1_x;
    }
    if (finger1_y)
    {
        *finger1_y = s_last_finger1_y;
    }
    if (rel_x)
    {
        *rel_x = s_last_rel_x;
    }
    if (rel_y)
    {
        *rel_y = s_last_rel_y;
    }
    return 0;
}

int mos_iqs7211a_register_runtime_callback(mos_iqs7211a_runtime_callback_t callback, void *user_data)
{
    s_runtime_callback_user_data = user_data;
    s_runtime_callback = callback;
    return 0;
}

int mos_iqs7211a_write_reg16(uint8_t reg, uint16_t value)
{
    /* Keep app-layer policy out of driver, but expose safe primitives. */
    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        return ret;
    }

    (void)iqs_force_comm_window();
    k_sleep(K_MSEC(5));
    return iqs_write_reg16((uint16_t)reg, value);
}

int mos_iqs7211a_write_block8(uint8_t start_reg, const uint8_t *data, size_t len)
{
    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        return ret;
    }

    (void)iqs_force_comm_window();
    k_sleep(K_MSEC(5));
    return iqs_write_block8(start_reg, data, len);
}

int mos_iqs7211a_update_reg16(uint8_t reg, uint16_t mask, uint16_t value)
{
    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        return ret;
    }

    (void)iqs_force_comm_window();
    k_sleep(K_MSEC(5));
    return iqs_update_reg16((uint16_t)reg, mask, value);
}

int mos_iqs7211a_get_debug_counters(uint32_t *isr_count, uint32_t *work_count, uint32_t *read_ok_count,
                                    uint32_t *read_fail_count, uint32_t *filtered_count)
{
    if (!isr_count && !work_count && !read_ok_count && !read_fail_count && !filtered_count)
    {
        return -EINVAL;
    }

    if (isr_count)
    {
        *isr_count = (uint32_t)atomic_get(&s_rdy_isr_count);
    }
    if (work_count)
    {
        *work_count = (uint32_t)atomic_get(&s_rdy_work_count);
    }
    if (read_ok_count)
    {
        *read_ok_count = (uint32_t)atomic_get(&s_rdy_read_ok_count);
    }
    if (read_fail_count)
    {
        *read_fail_count = (uint32_t)atomic_get(&s_rdy_read_fail_count);
    }
    if (filtered_count)
    {
        *filtered_count = (uint32_t)atomic_get(&s_rdy_filtered_count);
    }
    return 0;
}
