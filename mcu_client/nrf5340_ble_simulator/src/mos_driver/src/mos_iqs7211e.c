#include "mos_iqs7211e.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

LOG_MODULE_REGISTER(mos_iqs7211e, LOG_LEVEL_INF);

/* IQS7211E node -> parent I2C bus. Add alias iqs7211e = &iqs7211e in app.overlay. */
#define IQS_NODE DT_ALIAS(iqs7211e)
#define IQS_RDY_NODE DT_PATH(zephyr_user)

#if DT_NODE_EXISTS(IQS_NODE) && DT_NODE_EXISTS(IQS_RDY_NODE) && DT_NODE_HAS_PROP(IQS_RDY_NODE, iqs7211e_rdy_gpios)
#define IQS7211E_DT_READY 1
#define I2C_NODE DT_PARENT(IQS_NODE)
#else
#define IQS7211E_DT_READY 0
#endif
#define IQS_RDY_GPIO_INT 		GPIO_INT_EDGE_FALLING  // RDY pin goes low when data is ready, according to datasheet
#define IQS_RUNTIME_START_REG 	IQS7211E_REG_REL_X
#define IQS_FAE_CONFIG_SETTINGS0  (IQS7211E_CONFIG_TP_REATI_EN | IQS7211E_CONFIG_ALP_REATI_EN | IQS7211E_CONFIG_WDT |  IQS7211E_CONFIG_MANUAL_CONTROL)
#define IQS_RUNTIME_WORDS 	17U
#define IQS_VERSION_WORDS 	10U
#define IQS_MAX_BLOCK_WORDS 64U
#define IQS_MAX_BLOCK_BYTES 128U
#define IQS_RDY_WORKQ_STACK_SIZE 1024
#define IQS_RDY_WORKQ_PRIORITY K_PRIO_PREEMPT(6)
#define IQS_WAKE_RDY_POLL_MS 20
#define IQS_WAKE_RDY_TIMEOUT_MS 2000
#define IQS_WAKE_RDY_STABLE_IDLE_MS 200

#if IQS7211E_DT_READY

static const struct device *i2c_dev = NULL;
static atomic_t s_iqs_bus_ready = ATOMIC_INIT(0);
static atomic_t s_iqs_initialized = ATOMIC_INIT(0);

static int iqs_request_comm_window(void);
static int iqs_read_reg16(uint16_t reg, uint16_t *value);
static int iqs_read_block16(uint16_t start_reg, uint16_t *out_words, size_t words_count);
static int iqs_write_reg16(uint16_t reg, uint16_t value);
static int iqs_write_block8(uint8_t start_reg, const uint8_t *data, size_t len);
static int iqs_update_reg16(uint16_t reg, uint16_t mask, uint16_t value);
static int iqs_enable_stop_bit(void);
static int iqs_stop_comm_window(void);
static void iqs_prepare_polled_access(void);
static void iqs_try_fill_version_cache(void);
static int iqs_setup_rdy_interrupt(void);
static void iqs_start_rdy_work_queue(void);

static const struct gpio_dt_spec s_iqs_rdy_gpio = GPIO_DT_SPEC_GET(IQS_RDY_NODE, iqs7211e_rdy_gpios);
static struct gpio_callback s_iqs_rdy_cb;
static struct k_work s_iqs_rdy_work;
static struct k_work_q s_iqs_rdy_work_q;
static K_THREAD_STACK_DEFINE(s_iqs_rdy_work_q_stack, IQS_RDY_WORKQ_STACK_SIZE);
static atomic_t s_iqs_rdy_work_q_started = ATOMIC_INIT(0);
typedef struct
{
    uint16_t rel_x;
    uint16_t rel_y;
    uint16_t gestures;
    uint16_t info_flags;
    uint16_t finger1_x;
    uint16_t finger1_y;
    uint16_t touch_status0;
} iqs_runtime_frame_t;
typedef struct
{
    bool gpio_subscribed;
    atomic_t work_active;
} iqs_rdy_state_t;

static iqs_rdy_state_t s_rdy_state = {
    .gpio_subscribed = false,
    .work_active = ATOMIC_INIT(0),
};
static atomic_t s_iqs_cache_valid = ATOMIC_INIT(0);
static iqs_runtime_frame_t s_last_runtime = {0};

static mos_iqs7211e_runtime_callback_t s_runtime_callback = NULL;
static void *s_runtime_callback_user_data = NULL;

static uint16_t s_iqs_version_words[IQS_VERSION_WORDS];
static atomic_t s_iqs_version_cache_valid = ATOMIC_INIT(0);
static atomic_t s_iqs_version_fetch_pending = ATOMIC_INIT(0);
static K_SEM_DEFINE(s_iqs_version_sem, 0, 1);

static bool iqs_word_has_invalid_byte(uint16_t w)
{
    return (((w & 0x00FFu) == 0x00EEu) || (((w >> 8) & 0x00FFu) == 0x00EEu));
}

static bool iqs_word_is_obviously_invalid(uint16_t w)
{
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

static bool iqs_version_word_valid(uint16_t w)
{
    return !iqs_word_has_invalid_byte(w) && (w != 0xEEEEu);
}

static void iqs_store_runtime_words(const uint16_t *words)
{
    s_last_runtime.rel_x = words[0];
    s_last_runtime.rel_y = words[1];
    s_last_runtime.gestures = words[4];
    s_last_runtime.info_flags = words[5];
    s_last_runtime.finger1_x = words[6];
    s_last_runtime.finger1_y = words[7];
    s_last_runtime.touch_status0 = words[14];
    atomic_set(&s_iqs_cache_valid, 1);
}

static void iqs_take_runtime_snapshot(iqs_runtime_frame_t *frame)
{
    *frame = s_last_runtime;
}

static int iqs_get_cached_runtime_snapshot(iqs_runtime_frame_t *frame)
{
    if (frame == NULL)
    {
        return -EINVAL;
    }
    int ret = 0;
    if (!atomic_get(&s_iqs_cache_valid))
    {
        ret = -EAGAIN;
    }
    else
    {
        iqs_take_runtime_snapshot(frame);
    }
    return ret;
}

static bool iqs_runtime_words_valid(const uint16_t *words)
{
    const uint16_t gestures = words[4];
    const uint16_t info_flags = words[5];

    if (iqs_word_has_invalid_byte(gestures) || iqs_word_has_invalid_byte(info_flags))
    {
        return false;
    }
    if (iqs_word_is_obviously_invalid(gestures) || iqs_word_is_obviously_invalid(info_flags))
    {
        return false;
    }
    return true;
}

static void iqs_rdy_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    (void)iqs_enable_stop_bit();
    iqs_try_fill_version_cache();

    uint16_t words[IQS_RUNTIME_WORDS];
    bool cached = false;
    iqs_runtime_frame_t callback_frame = {0};

    for (int attempt = 0; attempt < 6; attempt++)
    {
        for (size_t i = 0U; i < IQS_RUNTIME_WORDS; i++)
        {
            words[i] = 0xEEEEu;
        }

        if (attempt > 0)
        {
            (void)iqs_request_comm_window();
            k_sleep(K_MSEC(2U + (uint32_t)(attempt - 1) * 4U));
            (void)iqs_enable_stop_bit();
        }

        int ret = iqs_read_block16(IQS_RUNTIME_START_REG, words, IQS_RUNTIME_WORDS);
        if (ret != 0)
        {
            continue;
        }

        if (!iqs_runtime_words_valid(words))
        {
            continue;
        }

        iqs_store_runtime_words(words);

        iqs_take_runtime_snapshot(&callback_frame);

        cached = true;
        break;
    }

    if (!cached && iqs_runtime_words_valid(words))
    {
        iqs_store_runtime_words(words);

        iqs_take_runtime_snapshot(&callback_frame);
        cached = true;
    }

    (void)iqs_stop_comm_window();

    if (cached && (s_runtime_callback != NULL))
    {
        s_runtime_callback(callback_frame.gestures, callback_frame.info_flags, callback_frame.finger1_x,
                           callback_frame.finger1_y, callback_frame.rel_x, callback_frame.rel_y,
                           s_runtime_callback_user_data);
    }

    atomic_set(&s_rdy_state.work_active, 0);
    (void)gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, IQS_RDY_GPIO_INT);
}

static void iqs_rdy_gpio_callback(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
    ARG_UNUSED(dev);
    ARG_UNUSED(cb);
    ARG_UNUSED(pins);

    if (!atomic_cas(&s_rdy_state.work_active, 0, 1))
    {
        return;
    }

    (void)gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, GPIO_INT_DISABLE);
    int ret = k_work_submit_to_queue(&s_iqs_rdy_work_q, &s_iqs_rdy_work);
    if (ret < 0)
    {
        atomic_set(&s_rdy_state.work_active, 0);
        (void)gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, IQS_RDY_GPIO_INT);
    }
}

static int iqs_read_reg16(uint16_t reg, uint16_t *value)
{
    if (value == NULL)
    {
        return -EINVAL;
    }

    uint8_t addr_buf[2];
    size_t addr_len;

    if (reg <= 0xFFU)
    {
        addr_buf[0] = (uint8_t)reg;
        addr_len = 1U;
    }
    else
    {
        addr_buf[0] = (uint8_t)((reg >> 8) & 0xFFU);
        addr_buf[1] = (uint8_t)(reg & 0xFFU);
        addr_len = 2U;
    }

    uint8_t data[2] = {0};
    int ret = i2c_write_read(i2c_dev, IQS7211E_I2C_ADDR, addr_buf, addr_len, data, sizeof(data));
    if (ret != 0)
    {
        LOG_ERR("iqs7211e read reg 0x%04x failed: %d", reg, ret);
        return ret;
    }

    *value = (uint16_t)data[0] | ((uint16_t)data[1] << 8);
    return 0;
}

static int iqs_read_block16(uint16_t start_reg, uint16_t *out_words, size_t words_count)
{
    if ((out_words == NULL) || (words_count == 0U))
    {
        return -EINVAL;
    }
    if ((start_reg > 0xFFU) || (words_count > IQS_MAX_BLOCK_WORDS))
    {
        return -EINVAL;
    }

    uint8_t addr = (uint8_t)start_reg;
    uint8_t buf[2U * IQS_MAX_BLOCK_WORDS] = {0};
    const size_t read_len = 2U * words_count;

    int ret = i2c_write_read(i2c_dev, IQS7211E_I2C_ADDR, &addr, sizeof(addr), buf, read_len);
    if (ret != 0)
    {
        return ret;
    }

    for (size_t i = 0U; i < words_count; i++)
    {
        out_words[i] = (uint16_t)buf[(2U * i) + 0U] | ((uint16_t)buf[(2U * i) + 1U] << 8);
    }
    return 0;
}

static int iqs_write_reg16(uint16_t reg, uint16_t value)
{
    uint8_t buf[4];
    size_t addr_len;

    if (reg <= 0xFFU)
    {
        buf[0] = (uint8_t)reg;
        addr_len = 1U;
    }
    else
    {
        buf[0] = (uint8_t)((reg >> 8) & 0xFFU);
        buf[1] = (uint8_t)(reg & 0xFFU);
        addr_len = 2U;
    }

    buf[addr_len + 0U] = (uint8_t)(value & 0xFFU);
    buf[addr_len + 1U] = (uint8_t)((value >> 8) & 0xFFU);

    int ret = i2c_write(i2c_dev, buf, addr_len + 2U, IQS7211E_I2C_ADDR);
    if (ret != 0)
    {
        LOG_ERR("iqs7211e write reg 0x%04x failed: %d", reg, ret);
    }
    return ret;
}

static int iqs_write_block8(uint8_t start_reg, const uint8_t *data, size_t len)
{
    if ((data == NULL) || (len == 0U) || (len > IQS_MAX_BLOCK_BYTES))
    {
        return -EINVAL;
    }

    uint8_t buf[1U + IQS_MAX_BLOCK_BYTES] = {0};
    buf[0] = start_reg;
    memcpy(&buf[1], data, len);

    return i2c_write(i2c_dev, buf, len + 1U, IQS7211E_I2C_ADDR);
}

static int iqs_update_reg16(uint16_t reg, uint16_t mask, uint16_t value)
{
    uint16_t cur = 0;
    int ret = iqs_read_reg16(reg, &cur);
    if (ret != 0)
    {
        return ret;
    }

    const uint16_t next = (uint16_t)((cur & ~mask) | (value & mask));
    if (next == cur)
    {
        return 0;
    }

    return iqs_write_reg16(reg, next);
}

static int iqs_request_comm_window(void)
{
    uint8_t cmd[2] = {IQS7211E_CMD_COMM_REQUEST, 0x00};
    int ret = i2c_write(i2c_dev, cmd, sizeof(cmd), IQS7211E_I2C_ADDR);
    if (ret != 0)
    {
        LOG_DBG("iqs7211e comm request failed: %d", ret);
    }
    return ret;
}

static int iqs_enable_stop_bit(void)
{
    const uint8_t config_settings0 = IQS_FAE_CONFIG_SETTINGS0 | (uint8_t)IQS7211E_CONFIG_COMMS_END_CMD;

    return iqs_write_block8(IQS7211E_REG_CONFIG_SETTINGS, &config_settings0, 1U);
}

static int iqs_stop_comm_window(void)
{
    const uint8_t cmd = IQS7211E_CMD_COMM_REQUEST;
    int ret = i2c_write(i2c_dev, &cmd, sizeof(cmd), IQS7211E_I2C_ADDR);
    if (ret != 0)
    {
        LOG_DBG("iqs7211e comm stop failed: %d", ret);
    }
    return ret;
}

static void iqs_prepare_polled_access(void)
{
    (void)iqs_request_comm_window();
    k_sleep(K_MSEC(5));
    (void)iqs_enable_stop_bit();
}

static void iqs_try_fill_version_cache(void)
{
    if (atomic_get(&s_iqs_version_cache_valid) && !atomic_get(&s_iqs_version_fetch_pending))
    {
        return;
    }

    uint16_t words[IQS_VERSION_WORDS] = {0};
    if (iqs_read_block16(IQS7211E_REG_PRODUCT_NUMBER, words, IQS_VERSION_WORDS) != 0)
    {
        return;
    }

    for (size_t i = 0U; i < IQS_VERSION_WORDS; i++)
    {
        if (!iqs_version_word_valid(words[i]))
        {
            return;
        }
    }

    for (size_t i = 0U; i < IQS_VERSION_WORDS; i++)
    {
        s_iqs_version_words[i] = words[i];
    }

    atomic_set(&s_iqs_version_cache_valid, 1);
    if (atomic_get(&s_iqs_version_fetch_pending))
    {
        atomic_set(&s_iqs_version_fetch_pending, 0);
        k_sem_give(&s_iqs_version_sem);
    }
}

static void iqs_start_rdy_work_queue(void)
{
    if (!atomic_cas(&s_iqs_rdy_work_q_started, 0, 1))
    {
        return;
    }

    static const struct k_work_queue_config config = {
        .name = "iqs7211e_rdy",
    };

    k_work_queue_start(&s_iqs_rdy_work_q,
                       s_iqs_rdy_work_q_stack,
                       K_THREAD_STACK_SIZEOF(s_iqs_rdy_work_q_stack),
                       IQS_RDY_WORKQ_PRIORITY, &config);
}

static int iqs_setup_rdy_interrupt(void)
{
    if (!gpio_is_ready_dt(&s_iqs_rdy_gpio))
    {
        return -ENODEV;
    }

    if (!s_rdy_state.gpio_subscribed)
    {
        int ret = gpio_pin_configure_dt(&s_iqs_rdy_gpio, GPIO_INPUT);
        if (ret != 0)
        {
            return ret;
        }

        iqs_start_rdy_work_queue();
        k_work_init(&s_iqs_rdy_work, iqs_rdy_work_handler);

        gpio_init_callback(&s_iqs_rdy_cb, iqs_rdy_gpio_callback, BIT(s_iqs_rdy_gpio.pin));
        ret = gpio_add_callback(s_iqs_rdy_gpio.port, &s_iqs_rdy_cb);
        if (ret != 0)
        {
            return ret;
        }
        s_rdy_state.gpio_subscribed = true;
    }

    if (atomic_get(&s_rdy_state.work_active))
    {
        return 0;
    }
    return gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, IQS_RDY_GPIO_INT);
}

int mos_iqs7211e_init(void)
{
    if (atomic_get(&s_iqs_initialized))
    {
        return 0;
    }

    if (!atomic_get(&s_iqs_bus_ready))
    {
        i2c_dev = device_get_binding(DT_NODE_FULL_NAME(I2C_NODE));
        if (i2c_dev == NULL)
        {
            LOG_ERR("IQS7211E: I2C device driver not found");
            return -ENODEV;
        }

        const uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
        int ret = i2c_configure(i2c_dev, i2c_cfg);
        if (ret != 0)
        {
            LOG_ERR("IQS7211E: I2C config failed: %d", ret);
            return ret;
        }

        atomic_set(&s_iqs_bus_ready, 1);
    }

    /* After System OFF the MCU resets but IQS7211E may stay in LP2 / manual mode from sleep prep;
     * direct reads can NACK (-EIO) until a comm window is opened. Cold boot is unaffected. */
    iqs_prepare_polled_access();

    uint16_t product_number = 0;
    uint16_t major_word = 0;
    uint16_t minor_word = 0;
    int ret = iqs_read_reg16(IQS7211E_REG_PRODUCT_NUMBER, &product_number);
    if (ret != 0)
    {
        LOG_ERR("IQS7211E: failed to read product number: %d", ret);
        return ret;
    }
    ret = iqs_read_reg16(IQS7211E_REG_MAJOR_VERSION, &major_word);
    if (ret != 0)
    {
        LOG_ERR("IQS7211E: failed to read major version: %d", ret);
        return ret;
    }
    ret = iqs_read_reg16(IQS7211E_REG_MINOR_VERSION, &minor_word);
    if (ret != 0)
    {
        LOG_ERR("IQS7211E: failed to read minor version: %d", ret);
        return ret;
    }
    LOG_INF("IQS7211E detected: product=0x%04x fw=%u.%u", product_number, (uint8_t)(major_word & 0x00FFu),
            (uint8_t)(minor_word & 0x00FFu));
    if (product_number != IQS7211E_PRODUCT_NUMBER_VALUE)
    {
        LOG_ERR("IQS7211E: unexpected product number 0x%04x (expected 0x%04x)", product_number,
                IQS7211E_PRODUCT_NUMBER_VALUE);
        return -ENODEV;
    }
    // SW reset
    ret = iqs_update_reg16(IQS7211E_REG_SYSTEM_CONTROL, IQS7211E_SYSTEM_SW_RESET, IQS7211E_SYSTEM_SW_RESET);
    if (ret != 0)
    {
        LOG_ERR("IQS7211E startup SW reset failed: %d", ret);
        return ret;
    }
    k_sleep(K_MSEC(120));

    (void)iqs_update_reg16(IQS7211E_REG_SYSTEM_CONTROL, IQS7211E_SYSTEM_ACK_RESET, IQS7211E_SYSTEM_ACK_RESET);
    (void)iqs_update_reg16(IQS7211E_REG_CONFIG_SETTINGS,
                           IQS7211E_CONFIG_EVENT_MODE | IQS7211E_CONFIG_GESTURE_EVENT | IQS7211E_CONFIG_TP_EVENT,
                           IQS7211E_CONFIG_EVENT_MODE | IQS7211E_CONFIG_GESTURE_EVENT | IQS7211E_CONFIG_TP_EVENT);

    atomic_set(&s_iqs_initialized, 1);
    LOG_INF("IQS7211E chip registers ready (addr=0x%02x)", IQS7211E_I2C_ADDR);

    return 0;
}

int mos_iqs7211e_enable_rdy_interrupt(void)
{
    if (!atomic_get(&s_iqs_initialized))
    {
        return -EAGAIN;
    }

    const bool first_rdy_setup = !s_rdy_state.gpio_subscribed;
    int ret = iqs_setup_rdy_interrupt();
    if ((ret == 0) && first_rdy_setup)
    {
        LOG_INF("IQS7211E RDY GPIO armed (active-low, falling edge)");
    }
    return ret;
}

int mos_iqs7211e_prepare_sleep_wakeup_mode(void)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    iqs_prepare_polled_access();

    const uint16_t mask = IQS7211E_CONFIG_MANUAL_CONTROL | IQS7211E_CONFIG_EVENT_MODE |
                          IQS7211E_CONFIG_GESTURE_EVENT | IQS7211E_CONFIG_TP_EVENT |
                          IQS7211E_CONFIG_TP_TOUCH_EVENT;
    const uint16_t value = IQS7211E_CONFIG_EVENT_MODE | IQS7211E_CONFIG_GESTURE_EVENT |
                           IQS7211E_CONFIG_TP_EVENT | IQS7211E_CONFIG_TP_TOUCH_EVENT;

    ret = iqs_update_reg16(IQS7211E_REG_CONFIG_SETTINGS, mask, value);
    (void)iqs_stop_comm_window();
    if (ret != 0)
    {
        LOG_ERR("Failed to prepare IQS7211E sleep wakeup mode: %d", ret);
        return ret;
    }

    LOG_INF("IQS7211E sleep wakeup mode prepared (manual control released)");
    return 0;
}

int mos_iqs7211e_configure_wakeup(void)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    if (!gpio_is_ready_dt(&s_iqs_rdy_gpio))
    {
        return -ENODEV;
    }

    (void)gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, GPIO_INT_DISABLE);
    (void)iqs_stop_comm_window();

    const bool active_low = ((s_iqs_rdy_gpio.dt_flags & GPIO_ACTIVE_LOW) != 0);
    int raw_level = 0;
    uint32_t stable_idle_ms = 0;
    for (uint32_t elapsed_ms = 0; elapsed_ms < IQS_WAKE_RDY_TIMEOUT_MS; elapsed_ms += IQS_WAKE_RDY_POLL_MS)
    {
        raw_level = gpio_pin_get_raw(s_iqs_rdy_gpio.port, s_iqs_rdy_gpio.pin);
        if (raw_level < 0)
        {
            LOG_ERR("Failed to read IQS7211E RDY GPIO raw level: %d", raw_level);
            return raw_level;
        }

        const bool rdy_active = active_low ? (raw_level == 0) : (raw_level != 0);
        if (!rdy_active)
        {
            stable_idle_ms += IQS_WAKE_RDY_POLL_MS;
            if (stable_idle_ms >= IQS_WAKE_RDY_STABLE_IDLE_MS)
            {
                LOG_INF("IQS7211E RDY idle for %u ms before System OFF wake setup", stable_idle_ms);
                break;
            }
        }
        else
        {
            stable_idle_ms = 0;
            (void)iqs_stop_comm_window();
        }

        k_sleep(K_MSEC(IQS_WAKE_RDY_POLL_MS));
    }

    const bool rdy_still_active = active_low ? (raw_level == 0) : (raw_level != 0);
    if (rdy_still_active || (stable_idle_ms < IQS_WAKE_RDY_STABLE_IDLE_MS))
    {
        LOG_WRN("IQS7211E RDY did not stay idle before System OFF; skip sleep to avoid immediate touch wake");
        return -EBUSY;
    }

    ret = gpio_pin_configure_dt(&s_iqs_rdy_gpio, GPIO_INPUT | (active_low ? GPIO_PULL_UP : GPIO_PULL_DOWN));
    if (ret != 0)
    {
        LOG_ERR("Failed to configure IQS7211E RDY input for wakeup: %d", ret);
        return ret;
    }

    ret = gpio_pin_interrupt_configure_dt(&s_iqs_rdy_gpio, GPIO_INT_LEVEL_ACTIVE);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure IQS7211E RDY level interrupt for wakeup: %d", ret);
        return ret;
    }

    raw_level = gpio_pin_get_raw(s_iqs_rdy_gpio.port, s_iqs_rdy_gpio.pin);
    if (raw_level < 0)
    {
        LOG_WRN("IQS7211E RDY wakeup configured, but final raw level read failed: %d", raw_level);
    }
    else
    {
        const bool rdy_active = active_low ? (raw_level == 0) : (raw_level != 0);
        LOG_INF("IQS7211E RDY configured for System OFF wakeup (LEVEL_ACTIVE, %s pin %u, raw=%d, active=%u)",
                s_iqs_rdy_gpio.port->name, s_iqs_rdy_gpio.pin, raw_level,
                (unsigned int)rdy_active);
    }
    return 0;
}

int mos_iqs7211e_register_runtime_callback(mos_iqs7211e_runtime_callback_t callback, void *user_data)
{
    s_runtime_callback_user_data = user_data;
    s_runtime_callback = callback;
    return 0;
}

int mos_iqs7211e_write_reg16(uint8_t reg, uint16_t value)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    iqs_prepare_polled_access();
    ret = iqs_write_reg16((uint16_t)reg, value);
    (void)iqs_stop_comm_window();
    return ret;
}

int mos_iqs7211e_read_reg16(uint8_t reg, uint16_t *value)
{
    if (value == NULL)
    {
        return -EINVAL;
    }

    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    iqs_prepare_polled_access();
    ret = iqs_read_reg16((uint16_t)reg, value);
    (void)iqs_stop_comm_window();
    return ret;
}

int mos_iqs7211e_write_block8(uint8_t start_reg, const uint8_t *data, size_t len)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    iqs_prepare_polled_access();
    ret = iqs_write_block8(start_reg, data, len);
    (void)iqs_stop_comm_window();
    return ret;
}

int mos_iqs7211e_update_reg16(uint8_t reg, uint16_t mask, uint16_t value)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    iqs_prepare_polled_access();
    ret = iqs_update_reg16((uint16_t)reg, mask, value);
    (void)iqs_stop_comm_window();
    return ret;
}

int mos_iqs7211e_read_version_details(uint16_t *out_words, size_t out_words_count)
{
    if ((out_words == NULL) || (out_words_count == 0U))
    {
        return -EINVAL;
    }

    size_t words = out_words_count;
    if (words > IQS_VERSION_WORDS)
    {
        words = IQS_VERSION_WORDS;
    }

    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    if (!atomic_get(&s_iqs_version_cache_valid))
    {
        iqs_prepare_polled_access();
        iqs_try_fill_version_cache();
        (void)iqs_stop_comm_window();
    }

    if (!atomic_get(&s_iqs_version_cache_valid))
    {
        atomic_set(&s_iqs_version_fetch_pending, 1);
        while (k_sem_take(&s_iqs_version_sem, K_NO_WAIT) == 0)
        {
        }

        if (k_sem_take(&s_iqs_version_sem, K_SECONDS(3)) != 0)
        {
            atomic_set(&s_iqs_version_fetch_pending, 0);
            return -EIO;
        }
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

int mos_iqs7211e_read_event_states(uint16_t *info_flags, uint16_t *gestures)
{
    if ((info_flags == NULL) && (gestures == NULL))
    {
        return -EINVAL;
    }

    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    uint16_t words[2] = {0xEEEEu, 0xEEEEu};
    for (int attempt = 0; attempt < 6; attempt++)
    {
        iqs_prepare_polled_access();
        ret = iqs_read_block16(IQS7211E_REG_GESTURES, words, 2U);
        (void)iqs_stop_comm_window();
        if (ret != 0)
        {
            continue;
        }
        if (iqs_word_has_invalid_byte(words[0]) || iqs_word_has_invalid_byte(words[1]))
        {
            continue;
        }

        if (gestures != NULL)
        {
            *gestures = words[0];
        }
        if (info_flags != NULL)
        {
            *info_flags = words[1];
        }
        return 0;
    }

    return -EIO;
}

int mos_iqs7211e_read_events(uint16_t *gestures)
{
    if (gestures == NULL)
    {
        return -EINVAL;
    }

    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    iqs_prepare_polled_access();
    ret = iqs_read_reg16(IQS7211E_REG_GESTURES, gestures);
    (void)iqs_stop_comm_window();
    return ret;
}

int mos_iqs7211e_is_touch_active(bool *active)
{
    if (active == NULL)
    {
        return -EINVAL;
    }

    uint16_t info_flags = 0;
    int ret = mos_iqs7211e_read_event_states(&info_flags, NULL);
    if (ret != 0)
    {
        return ret;
    }

    *active =
        (((info_flags & IQS7211E_INFO_NUM_FINGERS_MASK) >> 8) != 0U) || ((info_flags & IQS7211E_INFO_ALP_OUTPUT) != 0U);
    return 0;
}

int mos_iqs7211e_get_last_status(uint16_t *gestures, uint16_t *info_flags, uint16_t *touch_status0)
{
    if ((gestures == NULL) && (info_flags == NULL) && (touch_status0 == NULL))
    {
        return -EINVAL;
    }

    iqs_runtime_frame_t frame = {0};
    int ret = iqs_get_cached_runtime_snapshot(&frame);
    if (ret != 0)
    {
        return ret;
    }

    if (gestures != NULL)
    {
        *gestures = frame.gestures;
    }
    if (info_flags != NULL)
    {
        *info_flags = frame.info_flags;
    }
    if (touch_status0 != NULL)
    {
        *touch_status0 = frame.touch_status0;
    }
    return 0;
}

void mos_iqs7211e_clear_runtime_cache(void)
{
    atomic_set(&s_iqs_cache_valid, 0);
    memset(&s_last_runtime, 0, sizeof(s_last_runtime));
}

int mos_iqs7211e_refresh_runtime_cache(void)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }

    uint16_t words[IQS_RUNTIME_WORDS];
    ret = -EIO;

    /* Used after profile activation to consume the first runtime/sync frame before user gestures. */
    for (int attempt = 0; attempt < 6; attempt++)
    {
        for (size_t i = 0U; i < IQS_RUNTIME_WORDS; i++)
        {
            words[i] = 0xEEEEu;
        }

        iqs_prepare_polled_access();
        ret = iqs_read_block16(IQS_RUNTIME_START_REG, words, IQS_RUNTIME_WORDS);
        (void)iqs_stop_comm_window();
        if (ret == 0)
        {
            if (iqs_runtime_words_valid(words))
            {
                iqs_store_runtime_words(words);
                return 0;
            }
            ret = -EIO;
        }

        k_sleep(K_MSEC(20));
    }

    return ret;
}

int mos_iqs7211e_get_last_runtime_data(uint16_t *gestures, uint16_t *info_flags, uint16_t *finger1_x,
                                       uint16_t *finger1_y, uint16_t *rel_x, uint16_t *rel_y)
{
    if ((gestures == NULL) && (info_flags == NULL) && (finger1_x == NULL) && (finger1_y == NULL) && (rel_x == NULL) &&
        (rel_y == NULL))
    {
        return -EINVAL;
    }

    iqs_runtime_frame_t frame = {0};
    int ret = iqs_get_cached_runtime_snapshot(&frame);
    if (ret != 0)
    {
        return ret;
    }

    if (gestures != NULL)
    {
        *gestures = frame.gestures;
    }
    if (info_flags != NULL)
    {
        *info_flags = frame.info_flags;
    }
    if (finger1_x != NULL)
    {
        *finger1_x = frame.finger1_x;
    }
    if (finger1_y != NULL)
    {
        *finger1_y = frame.finger1_y;
    }
    if (rel_x != NULL)
    {
        *rel_x = frame.rel_x;
    }
    if (rel_y != NULL)
    {
        *rel_y = frame.rel_y;
    }
    return 0;
}

#endif
