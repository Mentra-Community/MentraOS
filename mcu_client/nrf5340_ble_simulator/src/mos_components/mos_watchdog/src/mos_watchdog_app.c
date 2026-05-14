#include "mos_watchdog_app.h"

#include <errno.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "mos_yhm4005.h"

LOG_MODULE_REGISTER(mos_watchdog_app, LOG_LEVEL_INF);

static bool s_initialized;
static bool s_available;
static bool s_enabled;
static uint32_t s_timeout_seconds;
static uint32_t s_feed_interval_ms;
static int s_last_error;
static struct k_work_delayable s_feed_work;

static void feed_work_handler(struct k_work *work);
static void schedule_next_feed(void);
static uint32_t get_feed_interval_ms(uint32_t timeout_seconds);
static int ensure_available(void);
static void set_last_error(int err);

int mos_watchdog_app_init(void)
{
    int ret;
    uint8_t id = 0;

    if (s_initialized)
    {
        return 0;
    }

    k_work_init_delayable(&s_feed_work, feed_work_handler);

    ret = mos_yhm4005_init();
    if (ret != 0)
    {
        set_last_error(ret);
        LOG_ERR("YHM4005 driver init failed: %d", ret);
        return ret;
    }

    ret = mos_yhm4005_read_id(&id);
    if (ret != 0)
    {
        set_last_error(ret);
        LOG_WRN("YHM4005 not available or ACMD read failed: %d", ret);
        s_initialized = true;
        return ret;
    }

    s_available = true;
    LOG_INF("YHM4005 ID: 0x%02x", id);

    ret = mos_yhm4005_disable();
    if (ret != 0)
    {
        set_last_error(ret);
        LOG_WRN("YHM4005 disable during init failed: %d", ret);
        s_initialized = true;
        return ret;
    }

    s_enabled = false;
    s_timeout_seconds = 0;
    s_feed_interval_ms = 0;
    set_last_error(0);
    s_initialized = true;
    LOG_INF("Watchdog app initialized, watchdog kept disabled by default");
    return 0;
}

int mos_watchdog_app_enable(uint32_t timeout_seconds)
{
    int ret;
    mos_yhm4005_timeout_t timeout;

    ret = ensure_available();
    if (ret != 0)
    {
        return ret;
    }

    ret = mos_yhm4005_timeout_seconds_to_code(timeout_seconds, &timeout);
    if (ret != 0)
    {
        set_last_error(ret);
        return ret;
    }

    ret = mos_yhm4005_enable(timeout, MOS_YHM4005_RESET_200MS);
    if (ret != 0)
    {
        set_last_error(ret);
        return ret;
    }

    s_enabled = true;
    s_timeout_seconds = timeout_seconds;
    s_feed_interval_ms = get_feed_interval_ms(timeout_seconds);
    set_last_error(0);
    schedule_next_feed();
    return 0;
}

int mos_watchdog_app_disable(void)
{
    int ret;

    ret = ensure_available();
    if (ret != 0)
    {
        return ret;
    }

    (void)k_work_cancel_delayable(&s_feed_work);

    ret = mos_yhm4005_disable();
    if (ret != 0)
    {
        set_last_error(ret);
        return ret;
    }

    s_enabled = false;
    s_timeout_seconds = 0;
    s_feed_interval_ms = 0;
    set_last_error(0);
    return 0;
}

int mos_watchdog_app_feed(void)
{
    int ret;

    ret = ensure_available();
    if (ret != 0)
    {
        return ret;
    }

    ret = mos_yhm4005_feed();
    set_last_error(ret);
    return ret;
}

int mos_watchdog_app_read_id(uint8_t *id)
{
    int ret;

    if (id == NULL)
    {
        return -EINVAL;
    }

    if (!s_initialized)
    {
        ret = mos_watchdog_app_init();
        if (ret != 0 && !s_initialized)
        {
            return ret;
        }
    }

    ret = mos_yhm4005_read_id(id);
    if (ret == 0)
    {
        s_available = true;
    }

    set_last_error(ret);
    return ret;
}

void mos_watchdog_app_get_status(mos_watchdog_status_t *status)
{
    if (status == NULL)
    {
        return;
    }

    status->initialized = s_initialized;
    status->available = s_available;
    status->enabled = s_enabled;
    status->timeout_seconds = s_timeout_seconds;
    status->feed_interval_ms = s_feed_interval_ms;
    status->last_error = s_last_error;
}

static void feed_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    if (!s_enabled)
    {
        return;
    }

    int ret = mos_yhm4005_feed();
    if (ret != 0)
    {
        set_last_error(ret);
        LOG_ERR("YHM4005 feed failed: %d", ret);
    }
    else
    {
        set_last_error(0);
    }

    schedule_next_feed();
}

static void schedule_next_feed(void)
{
    if (!s_enabled || s_feed_interval_ms == 0)
    {
        return;
    }

    (void)k_work_reschedule(&s_feed_work, K_MSEC(s_feed_interval_ms));
}

static uint32_t get_feed_interval_ms(uint32_t timeout_seconds)
{
    uint32_t interval_ms = (timeout_seconds * 1000U) / MOS_WATCHDOG_APP_FEED_DIVISOR;

    if (interval_ms < MOS_WATCHDOG_APP_MIN_FEED_INTERVAL_MS)
    {
        interval_ms = MOS_WATCHDOG_APP_MIN_FEED_INTERVAL_MS;
    }

    return interval_ms;
}

static int ensure_available(void)
{
    int ret;
    uint8_t id = 0;

    if (!s_initialized)
    {
        ret = mos_watchdog_app_init();
        if (ret != 0 && !s_initialized)
        {
            return ret;
        }
    }

    if (s_available)
    {
        return 0;
    }

    ret = mos_yhm4005_read_id(&id);
    if (ret != 0)
    {
        set_last_error(ret);
        return ret;
    }

    s_available = true;
    set_last_error(0);
    return 0;
}

static void set_last_error(int err)
{
    s_last_error = err;
}
