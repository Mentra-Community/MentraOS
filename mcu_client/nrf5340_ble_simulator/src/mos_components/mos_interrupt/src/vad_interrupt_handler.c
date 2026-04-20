/*
 * @Author       : Cole
 * @Date         : 2026-03-03 17:06:05
 * @LastEditTime : 2026-04-20 17:53:51
 * @FilePath     : vad_interrupt_handler.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "vad_interrupt_handler.h"

#include <errno.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

#include "main.h"
#include "mos_gx8002.h"
#include "mos_i2s_slave.h"
#include "interrupt_handler.h"

LOG_MODULE_REGISTER(vad_int_handler, LOG_LEVEL_INF);

#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), vad_voice_detect_gpios)
#define VAD_VOICE_DETECT_GPIO_AVAILABLE 1
static const struct gpio_dt_spec vad_voice_detect = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), vad_voice_detect_gpios);
#else
#define VAD_VOICE_DETECT_GPIO_AVAILABLE 0
#endif

#define VAD_TIMEOUT_BASE_MS 5000
#define VAD_TIMEOUT_CONFIRM_SAMPLES 3
#define VAD_TIMEOUT_CONFIRM_INTERVAL_MS 20

static bool vad_int_initialized = false;
static bool i2s_reception_active = false;
static int64_t s_vad_trigger_tick = 0;

int64_t vad_get_trigger_tick(void)
{
    return s_vad_trigger_tick;
}

static bool mic_capture_enabled = false;
static int32_t current_timeout_ms = 0;
static struct k_timer vad_timeout_timer;
static uint32_t s_last_ble_skip_log_ts = 0;
static atomic_t s_vad_event_pending = ATOMIC_INIT(0);

static void vad_interrupt_handler_update_enabled_state(bool enabled)
{
    mic_capture_enabled = enabled;

    if (!enabled)
    {
        k_timer_stop(&vad_timeout_timer);
        current_timeout_ms = 0;
    }
}

static void vad_interrupt_handler_update_i2s_state(bool active)
{
    i2s_reception_active = active;

    if (!active)
    {
        current_timeout_ms = 0;
        s_vad_trigger_tick = 0;
        k_timer_stop(&vad_timeout_timer);
    }
}

static void vad_interrupt_handler_stop_i2s_capture(const char *log_msg)
{
    (void)gx8002_i2s_stop();
    (void)mos_gx8002_disable_i2s();
    vad_interrupt_handler_update_i2s_state(false);

    if (log_msg != NULL)
    {
        LOG_INF("%s", log_msg);
    }
}

static bool vad_interrupt_handler_try_acquire_event_slot(void)
{
    return atomic_cas(&s_vad_event_pending, 0, 1);
}

static void vad_interrupt_handler_release_event_slot(void)
{
    (void)atomic_set(&s_vad_event_pending, 0);
}

int vad_voice_detect_set_low(void)
{
    if (!VAD_VOICE_DETECT_GPIO_AVAILABLE || vad_voice_detect.port == NULL || !device_is_ready(vad_voice_detect.port))
    {
        return -ENODEV;
    }

    int ret = gpio_pin_configure_dt(&vad_voice_detect, GPIO_OUTPUT);
    if (ret != 0)
    {
        return ret;
    }

    ret = gpio_pin_set_dt(&vad_voice_detect, 0);
    if (ret == 0)
    {
        LOG_INF("vad_voice_detect forced LOW");
    }
    return ret;
}

int vad_voice_detect_set_high(void)
{
    if (!VAD_VOICE_DETECT_GPIO_AVAILABLE || vad_voice_detect.port == NULL || !device_is_ready(vad_voice_detect.port))
    {
        return -ENODEV;
    }

    int ret = gpio_pin_configure_dt(&vad_voice_detect, GPIO_INPUT | GPIO_PULL_UP);
    if (ret == 0)
    {
        LOG_INF("vad_voice_detect default HIGH (input pull-up)");
    }
    return ret;
}

static bool vad_check_voice_detect_gpio(void)
{
    if (!VAD_VOICE_DETECT_GPIO_AVAILABLE)
    {
        return false;
    }

    if (vad_voice_detect.port == NULL || !device_is_ready(vad_voice_detect.port))
    {
        return false;
    }

    int value = gpio_pin_get_dt(&vad_voice_detect);
    LOG_INF("VAD voice_detect level=%d (0=voice,1=silence)", value);
    return value == 0;  // Active low: 0 means voice detected, 1 means no voice
}
/*
 * @note: This is to avoid false VAD timeout trigger due to transient noise or brief pauses in speech, ensuring better user experience by keeping the mic capture active if voice is still present. 
 *  这是为了避免由于瞬时噪声或短暂的语音停顿引起的错误VAD超时触发，通过确认如果仍然存在语音则保持麦克风捕获活动，从而确保更好的用户体验。
*/
static bool vad_check_voice_detect_stable(void)
{
    for (int i = 0; i < VAD_TIMEOUT_CONFIRM_SAMPLES; ++i)
    {
        if (!vad_check_voice_detect_gpio())
        {
            LOG_INF("VAD timeout confirm: sample %d/%d indicates silence, stopping capture", i + 1,
                    VAD_TIMEOUT_CONFIRM_SAMPLES);
            return false;
        }

        if (i + 1 < VAD_TIMEOUT_CONFIRM_SAMPLES)
        {
            k_sleep(K_MSEC(VAD_TIMEOUT_CONFIRM_INTERVAL_MS));
        }
    }

    LOG_INF("VAD timeout confirm: %d/%d samples indicate voice, keep capture", VAD_TIMEOUT_CONFIRM_SAMPLES,
            VAD_TIMEOUT_CONFIRM_SAMPLES);
    return true;
}

static void vad_timeout_callback(interrupt_event_t *event)
{
    ARG_UNUSED(event);

    if (!vad_interrupt_handler_is_enabled())
    {
        if (vad_interrupt_handler_is_i2s_active())
        {
            vad_interrupt_handler_stop_i2s_capture("VAD timeout: mic disabled, force stop I2S capture");
        }
        return;
    }

    if (!vad_interrupt_handler_is_i2s_active())
    {
        return;
    }

    if (!get_ble_connected_status())
    {
        vad_interrupt_handler_stop_i2s_capture("VAD timeout: BLE disconnected, stop I2S capture");
        return;
    }

    if (vad_check_voice_detect_stable())
    {
        current_timeout_ms = VAD_TIMEOUT_BASE_MS;
        k_timer_start(&vad_timeout_timer, K_MSEC(current_timeout_ms), K_NO_WAIT);
        LOG_INF("VAD timeout check: voice still active, keep I2S capture");
        return;
    }

    vad_interrupt_handler_stop_i2s_capture("VAD timeout: stop GX8002 I2S capture");
}

static void vad_interrupt_callback(interrupt_event_t *event)
{
    bool should_re_enable_irq = false;

    if (event == NULL || event->event != INTERRUPT_TYPE_VAD_FALLING_EDGE)
    {
        goto out;
    }

    if (!vad_interrupt_handler_is_enabled())
    {
        LOG_INF("VAD interrupt ignored: mic capture disabled, tick=%lld", event->tick);
        goto out;
    }

    if (!get_ble_connected_status())
    {
        uint32_t now = k_uptime_get_32();
        if (now - s_last_ble_skip_log_ts > 5000u)
        {
            s_last_ble_skip_log_ts = now;
            LOG_INF("VAD interrupt ignored: BLE disconnected, skip I2S start");
        }
        should_re_enable_irq = true;
        goto out;
    }

    LOG_INF("VAD interrupt: falling edge detected, tick=%lld", event->tick);

    if (!vad_interrupt_handler_is_i2s_active())
    {
        s_vad_trigger_tick = event->tick;

        /*
         * Test path: GX8002 VAD firmware now enables IIS immediately when it raises
         * the interrupt, so skip the MCU I2C enable command to reduce trigger latency.
         * Keep the old command here for quick rollback after validation.
         */
        /*
        if (!mos_gx8002_enable_i2s())
        {
            LOG_WRN("GX8002 enable i2s failed");
        }
        */

        if (gx8002_i2s_start() != 0)
        {
            LOG_ERR("nRF5340 i2s slave start failed");
            should_re_enable_irq = true;
            goto out;
        }

        vad_interrupt_handler_update_i2s_state(true);
        LOG_INF("VAD action: I2S capture started");
    }
    else
    {
        LOG_INF("VAD action: I2S capture already active, refresh timeout");
    }

    current_timeout_ms = VAD_TIMEOUT_BASE_MS;
    k_timer_stop(&vad_timeout_timer);
    k_timer_start(&vad_timeout_timer, K_MSEC(current_timeout_ms), K_NO_WAIT);

    should_re_enable_irq = true;

out:
    vad_interrupt_handler_release_event_slot();
    if (should_re_enable_irq)
    {
        (void)vad_interrupt_handler_re_enable();
    }
}

static void vad_timeout_handler(struct k_timer *timer)
{
    ARG_UNUSED(timer);

    interrupt_event_t timeout_event = {
        .event = INTERRUPT_TYPE_VAD_TIMEOUT,
        .tick = k_uptime_get(),
        .data = NULL,
    };

    (void)interrupt_handler_send_event(&timeout_event);
}

int vad_interrupt_handler_send_event(void)
{
    interrupt_event_t event = {
        .event = INTERRUPT_TYPE_VAD_FALLING_EDGE,
        .tick = k_uptime_get(),
        .data = NULL,
    };

    if (!vad_interrupt_handler_try_acquire_event_slot())
    {
        LOG_DBG("VAD ISR event coalesced, tick=%lld", event.tick);
        return -EALREADY;
    }

    int ret = interrupt_handler_send_event(&event);
    if (ret != 0)
    {
        vad_interrupt_handler_release_event_slot();
        LOG_ERR("VAD ISR event enqueue failed, tick=%lld ret=%d", event.tick, ret);
    }
    else
    {
        LOG_INF("VAD ISR event queued, tick=%lld", event.tick);
    }

    return ret;
}

int vad_interrupt_handler_re_enable(void)
{
    return mos_gx8002_vad_int_re_enable();
}

bool vad_interrupt_handler_is_i2s_active(void)
{
    return i2s_reception_active;
}

void vad_interrupt_handler_notify_i2s_stopped(void)
{
    vad_interrupt_handler_update_i2s_state(false);
}

void vad_interrupt_handler_set_enabled(bool enabled)
{
    vad_interrupt_handler_update_enabled_state(enabled);
}

bool vad_interrupt_handler_is_enabled(void)
{
    return mic_capture_enabled;
}

int vad_interrupt_handler_init(void)
{
    if (vad_int_initialized)
    {
        LOG_INF("VAD interrupt handler already initialized");
        return 0;
    }

    if (VAD_VOICE_DETECT_GPIO_AVAILABLE && vad_voice_detect.port != NULL && device_is_ready(vad_voice_detect.port))
    {
        (void)vad_voice_detect_set_high();
        int level = gpio_pin_get_dt(&vad_voice_detect);
        LOG_INF("VAD voice_detect GPIO ready: port=%s pin=%u level=%d", vad_voice_detect.port->name,
                vad_voice_detect.pin, level);
    }
    else
    {
        LOG_WRN("VAD voice_detect GPIO unavailable, timeout logic will rely on defaults");
    }

    k_timer_init(&vad_timeout_timer, vad_timeout_handler, NULL);

    int ret = interrupt_handler_register_callback(INTERRUPT_TYPE_VAD_FALLING_EDGE, vad_interrupt_callback);
    if (ret != 0)
    {
        return ret;
    }

    ret = interrupt_handler_register_callback(INTERRUPT_TYPE_VAD_TIMEOUT, vad_timeout_callback);
    if (ret != 0)
    {
        return ret;
    }

    vad_int_initialized = true;
    LOG_INF("VAD interrupt handler initialized");
    return 0;
}
