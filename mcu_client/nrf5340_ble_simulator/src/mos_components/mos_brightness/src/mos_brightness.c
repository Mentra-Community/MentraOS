#include "mos_brightness.h"

#include <stdlib.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "display/lcd/a6n.h"
#include "mos_opt3006.h"

LOG_MODULE_REGISTER(mos_brightness, LOG_LEVEL_INF);

/* ---------- Tuned for the installed sensor position ----------
 *
 * The OPT3006 inlet faces downward near the frame, so installed readings are
 * much lower than standard desk lux meter readings. Treat this curve as
 * "effective device lux" rather than room illuminance.
 */
#define BRIGHTNESS_POLL_INTERVAL_MS 1500U /* 亮度轮询间隔时间（毫秒）/ Brightness polling interval (ms) */
#define BRIGHTNESS_MIN_MULTIPLIER 0.10f /* 最小亮度乘数（10%）/ Minimum brightness multiplier (10%) */
#define BRIGHTNESS_MAX_MULTIPLIER 3.00f /* 最大亮度乘数（300%）/ Maximum brightness multiplier (300%) */
#define BRIGHTNESS_MIN_PERCENT 30U /* 最小亮度百分比（30%）/ Minimum brightness percent (30%) */
#define BRIGHTNESS_MAX_PERCENT 100U /* 最大亮度百分比（100%）/ Maximum brightness percent (100%) */
#define BRIGHTNESS_UP_HYSTERESIS_PCT 3U /* 亮度上调滞后阈值（+3%）/ Upward hysteresis threshold (+3%) */
#define BRIGHTNESS_DOWN_HYSTERESIS_PCT 4U /* 亮度下调滞后阈值（-4%）/ Downward hysteresis threshold (-4%) */
#define BRIGHTNESS_MIN_APPLY_INTERVAL_MS 5000LL /* 亮度最小应用间隔（毫秒）/ Minimum interval between brightness applies (ms) */

/* 亮度 EMA 平滑系数 / EMA smoothing factor for brightness */
#define BRIGHTNESS_EMA_ALPHA 0.30f /* EMA 系数（0-1，越大响应越快）/ EMA alpha (0-1, larger means faster response) */

typedef struct
{
    float lux;  // 光照强度（单位：勒克斯）/ Light intensity in lux
    uint32_t brightness_percent;  // 亮度百分比（0-100%）/ Brightness percent (0-100%)
} brightness_point_t;

static const brightness_point_t s_curve[] = {
    {0.0f, 30U}, {10.0f, 30U}, {30.0f, 50U}, {80.0f, 58U}, {150.0f, 68U}, {300.0f, 85U}, {500.0f, 100U},
};

/* ---------- state ---------- */

static uint32_t s_current_level = 50U; /* actual display brightness (0-100%) */
static uint32_t s_manual_level = 50U; /* saved manual level for AUTO→OFF restore */
static bool s_auto_enabled = false;
static float s_multiplier = 1.0f; /* brightness multiplier (0.10-3.00) */
static float s_last_lux = -1.0f; /* -1 = not yet read */
static float s_filtered_lux = -1.0f; /* -1 = not yet initialized */
static int s_last_sensor_error = 0;
static int64_t s_last_auto_apply_ms = 0;
static bool s_auto_apply_initialized = false;
static bool s_sample_log_enabled = false;// 前期调试用，用于记录传感器数据，正式项目中可删除或改为 runtime 可控/ For debugging, used to record sensor data, can be deleted or made runtime controllable in the formal project

static struct k_work_delayable s_work;
static bool s_work_initialized = false;

/* ---------- forward declarations ---------- */

static void brightness_work_handler(struct k_work *work);
static void brightness_ensure_initialized(void);
static void brightness_schedule(uint32_t delay_ms);
static uint32_t brightness_compute_auto_level(float lux, float multiplier);
static void brightness_apply(uint32_t level, bool update_manual, bool disable_auto, const char *src);

/* ---------- helpers ---------- */

static uint32_t clamp_percent(uint32_t v)
{
    return (v > BRIGHTNESS_MAX_PERCENT) ? BRIGHTNESS_MAX_PERCENT : v;
}

static float clamp_multiplier(float m)
{
    if (m < BRIGHTNESS_MIN_MULTIPLIER)
        return BRIGHTNESS_MIN_MULTIPLIER;
    if (m > BRIGHTNESS_MAX_MULTIPLIER)
        return BRIGHTNESS_MAX_MULTIPLIER;
    return m;
}

static void brightness_ensure_initialized(void)
{
    if (!s_work_initialized)
    {
        k_work_init_delayable(&s_work, brightness_work_handler);
        s_work_initialized = true;
    }
}

static void brightness_schedule(uint32_t delay_ms)
{
    brightness_ensure_initialized();
    (void)k_work_reschedule(&s_work, K_MSEC(delay_ms));
}

static uint32_t brightness_compute_auto_level(float lux, float multiplier)
{
    float cm = clamp_multiplier(multiplier);
    size_t n = ARRAY_SIZE(s_curve);
    float base;

    if (lux <= s_curve[0].lux)
    {
        base = (float)s_curve[0].brightness_percent;
    }
    else if (lux >= s_curve[n - 1].lux)
    {
        base = (float)s_curve[n - 1].brightness_percent;
    }
    else
    {
        base = (float)s_curve[n - 1].brightness_percent;
        for (size_t i = 1; i < n; ++i)
        {
            if (lux <= s_curve[i].lux)
            {
                float range = s_curve[i].lux - s_curve[i - 1].lux;
                float t = (range > 0.0f) ? ((lux - s_curve[i - 1].lux) / range) : 0.0f;
                base = (float)s_curve[i - 1].brightness_percent
                       + t * ((float)s_curve[i].brightness_percent - (float)s_curve[i - 1].brightness_percent);
                break;
            }
        }
    }

    float scaled = base * cm;
    if (scaled < (float)BRIGHTNESS_MIN_PERCENT)
        scaled = (float)BRIGHTNESS_MIN_PERCENT;
    if (scaled > (float)BRIGHTNESS_MAX_PERCENT)
        scaled = (float)BRIGHTNESS_MAX_PERCENT;
    return (uint32_t)(scaled + 0.5f);
}

static void brightness_apply(uint32_t level, bool update_manual, bool disable_auto, const char *src)
{
    level = clamp_percent(level);

    if (disable_auto && s_auto_enabled)
    {
        LOG_INF("[BRIGHTNESS] %s: disabling AUTO", src);
        s_auto_enabled = false;
        s_auto_apply_initialized = false;
        if (s_work_initialized)
        {
            (void)k_work_cancel_delayable(&s_work);
        }
    }

    if (update_manual)
    {
        s_manual_level = level;
    }

    if (s_current_level == level)
    {
        return;
    }
    uint8_t reg = (uint8_t)((level * 255U) / 100U);
    int ret = a6n_set_brightness(reg);
    if (ret == 0)
    {
        s_current_level = level;
        LOG_INF("[BRIGHTNESS] %s: %u%% -> reg 0x%02X", src, level, reg);
    }
    else
    {
        LOG_ERR("[BRIGHTNESS] %s: a6n_set_brightness(0x%02X) failed: %d", src, reg, ret);
    }
}

/* ---------- AUTO polling work handler ---------- */
static void brightness_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    if (!s_auto_enabled)
    {
        return;
    }

    float lux = 0.0f;
    int ret = opt3006_read_lux(&lux);
    if (ret != 0)
    {
        s_last_sensor_error = ret;
        LOG_WRN("[BRIGHTNESS] opt3006_read_lux failed: %d", ret);
        brightness_schedule(BRIGHTNESS_POLL_INTERVAL_MS);
        return;
    }
    s_last_sensor_error = 0;
    s_last_lux = lux;
    if (s_filtered_lux < 0.0f)
    {
        s_filtered_lux = lux;
    }
    else
    {
        s_filtered_lux = (s_filtered_lux * (1.0f - BRIGHTNESS_EMA_ALPHA)) + (lux * BRIGHTNESS_EMA_ALPHA);
    }

    uint32_t target = brightness_compute_auto_level(s_filtered_lux, s_multiplier);
    uint32_t current = s_current_level;
    uint32_t delta = (target > current) ? (target - current) : (current - target);
    uint32_t hysteresis = (target > current) ? BRIGHTNESS_UP_HYSTERESIS_PCT : BRIGHTNESS_DOWN_HYSTERESIS_PCT;
    int64_t now = k_uptime_get();
    bool interval_elapsed =
        !s_auto_apply_initialized || ((now - s_last_auto_apply_ms) >= BRIGHTNESS_MIN_APPLY_INTERVAL_MS);

    if (s_sample_log_enabled)
    {
        LOG_INF("[BRIGHTNESS] AUTO lux=%.2f filt=%.2f mult=%.2f target=%u%% current=%u%% delta=%u%% hyst=%u%%",
                (double)lux, (double)s_filtered_lux, (double)s_multiplier, target, current, delta, hysteresis);
    }

    if ((delta >= hysteresis) && interval_elapsed)
    {
        brightness_apply(target, false, false, "auto");
        s_last_auto_apply_ms = now;
        s_auto_apply_initialized = true;
    }

    if (s_auto_enabled)
    {
        brightness_schedule(BRIGHTNESS_POLL_INTERVAL_MS);
    }
}

/* ============================================================
 * Public API
 * ============================================================ */

void mos_brightness_request_manual(uint32_t level_percent)
{
    brightness_apply(level_percent, true, true, "manual");
}

void mos_brightness_request_auto_enabled(bool enabled)
{
    bool prev = s_auto_enabled;

    if (enabled)
    {
        brightness_ensure_initialized();
        s_auto_enabled = true;
        s_filtered_lux = -1.0f;
        s_last_sensor_error = 0;
        s_auto_apply_initialized = false;
        LOG_INF("[BRIGHTNESS] AUTO %s -> ON  manual_level=%u%% mult=%.2f", prev ? "ON" : "OFF", s_manual_level,
                (double)s_multiplier);
        brightness_schedule(0U);
    }
    else
    {
        s_auto_enabled = false;
        s_auto_apply_initialized = false;
        if (s_work_initialized)
        {
            (void)k_work_cancel_delayable(&s_work);
        }
        LOG_INF("[BRIGHTNESS] AUTO %s -> OFF  restoring manual=%u%%", prev ? "ON" : "OFF", s_manual_level);
        brightness_apply(s_manual_level, false, false, "auto-off restore");
    }
}

void mos_brightness_request_multiplier(float multiplier)
{
    float prev = s_multiplier;
    float clamped = clamp_multiplier(multiplier);
    s_multiplier = clamped;

    if (multiplier != clamped)
    {
        LOG_WRN("[BRIGHTNESS] multiplier %.2f clamped to %.2f", (double)multiplier, (double)clamped);
    }
    LOG_INF("[BRIGHTNESS] multiplier %.2f -> %.2f auto=%s", (double)prev, (double)clamped,
            s_auto_enabled ? "ON" : "OFF");

    if (s_auto_enabled)
    {
        brightness_schedule(0U);
    }
}

void mos_brightness_set_sample_log_enabled(bool enabled)
{
    s_sample_log_enabled = enabled;
    LOG_INF("[BRIGHTNESS] AUTO sample log %s", enabled ? "ON" : "OFF");
}

void mos_brightness_get_status(mos_brightness_status_t *status)
{
    if (!status)
    {
        return;
    }

    status->current_level_percent = s_current_level;
    status->auto_enabled = s_auto_enabled;
    status->multiplier = s_multiplier;
    status->last_lux = s_last_lux;
    status->filtered_lux = s_filtered_lux;
    status->last_sensor_error = s_last_sensor_error;
    status->sample_log_enabled = s_sample_log_enabled;
}
