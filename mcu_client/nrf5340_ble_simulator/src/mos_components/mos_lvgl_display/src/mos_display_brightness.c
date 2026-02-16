/*
 * Display brightness: level and auto brightness state, A6N control, and
 * a thread that reads OPT3006 and updates brightness when auto is enabled.
 */

#include "mos_display_brightness.h"

#include <math.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <display/lcd/a6n.h>
#include "mos_opt3006.h"

LOG_MODULE_REGISTER(mos_display_brightness, LOG_LEVEL_INF);

#define TASK_AUTO_BRIGHTNESS_NAME "MOS_AUTO_BRIGHT"
#define AUTO_BRIGHTNESS_THREAD_STACK_SIZE 1024
#define AUTO_BRIGHTNESS_THREAD_PRIORITY   7
#define AUTO_BRIGHTNESS_POLL_MS           500

#define LUX_MIN   10.0f
#define LUX_MAX   10000.0f
#define LEVEL_MIN 10u
#define LEVEL_MAX 100u

static uint32_t current_brightness_level = 50;
static bool     auto_brightness_enabled  = false;

K_THREAD_STACK_DEFINE(auto_brightness_stack, AUTO_BRIGHTNESS_THREAD_STACK_SIZE);
static struct k_thread auto_brightness_thread_data;

static uint32_t lux_to_brightness_level(float lux)
{
    if (lux <= LUX_MIN)
    {
        return LEVEL_MIN;
    }
    if (lux >= LUX_MAX)
    {
        return LEVEL_MAX;
    }
    float log_lux  = (float)log10f(lux);
    float log_min  = (float)log10f(LUX_MIN);
    float log_max  = (float)log10f(LUX_MAX);
    float ratio    = (log_lux - log_min) / (log_max - log_min);
    uint32_t level = LEVEL_MIN + (uint32_t)((LEVEL_MAX - LEVEL_MIN) * ratio + 0.5f);
    if (level > LEVEL_MAX)
    {
        level = LEVEL_MAX;
    }
    return level;
}

/** Set A6N hardware and internal level (used by manual path and by auto thread). */
static void set_hardware_level(uint32_t level)
{
    if (level > 100)
    {
        level = 100;
    }
    current_brightness_level = level;
    uint8_t reg_value = (level * 255) / 100;
    int ret = a6n_set_brightness(reg_value);
    if (ret != 0)
    {
        LOG_ERR("Display brightness: a6n_set_brightness failed: %d", ret);
    }
}

static void auto_brightness_thread_entry(void *p1, void *p2, void *p3)
{
    ARG_UNUSED(p1);
    ARG_UNUSED(p2);
    ARG_UNUSED(p3);

    for (;;)
    {
        k_sleep(K_MSEC(AUTO_BRIGHTNESS_POLL_MS));

        if (!auto_brightness_enabled)
        {
            continue;
        }

        float lux = 0.0f;
        int ret = opt3006_read_lux(&lux);
        if (ret != 0)
        {
            LOG_DBG("Auto brightness: sensor read failed: %d", ret);
            continue;
        }

        uint32_t level = lux_to_brightness_level(lux);
        set_hardware_level(level);
        LOG_DBG("Auto brightness: lux=%.1f -> %u%%", (double)lux, level);
    }
}

void display_brightness_thread_start(void)
{
    k_tid_t tid = k_thread_create(&auto_brightness_thread_data,
                                  auto_brightness_stack,
                                  K_THREAD_STACK_SIZEOF(auto_brightness_stack),
                                  auto_brightness_thread_entry,
                                  NULL,
                                  NULL,
                                  NULL,
                                  AUTO_BRIGHTNESS_THREAD_PRIORITY,
                                  0,
                                  K_NO_WAIT);
    k_thread_name_set(tid, TASK_AUTO_BRIGHTNESS_NAME);
    LOG_INF("Display brightness (auto) thread started");
}

void display_brightness_set_level(uint32_t level)
{
    if (level > 100)
    {
        level = 100;
    }
    if (auto_brightness_enabled)
    {
        LOG_INF("Manual brightness - disabling auto brightness");
        auto_brightness_enabled = false;
    }
    set_hardware_level(level);
}

void display_brightness_set_auto_enabled(bool enabled)
{
    auto_brightness_enabled = enabled;
}

uint32_t display_brightness_get_level(void)
{
    return current_brightness_level;
}

bool display_brightness_get_auto_enabled(void)
{
    return auto_brightness_enabled;
}
