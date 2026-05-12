#include "mos_display_settings.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>

LOG_MODULE_REGISTER(mos_display_settings, LOG_LEVEL_INF);

#define SETTINGS_ROOT  "mos/display"
#define KEY_HEIGHT     "height"
#define KEY_HEIGHT_FULL SETTINGS_ROOT "/" KEY_HEIGHT

#define DISPLAY_HEIGHT_MIN 1u
#define DISPLAY_HEIGHT_MAX 8u

/* Debounce a burst of save requests (e.g. a slider) into a single flash write. */
#define FLUSH_DEBOUNCE_MS 1000

/* In-RAM authoritative value (what get_height returns and the settings loader populates). */
static uint8_t s_height;
static bool    s_height_valid;

/* Mirror of what's currently in flash, so we can skip writes when nothing changed. */
static uint8_t s_persisted_height;
static bool    s_persisted_valid;

static void flush_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(s_flush_work, flush_work_handler);

static int display_settings_set(const char *name, size_t len,
                                settings_read_cb read_cb, void *cb_arg)
{
    const char *next;

    if (settings_name_steq(name, KEY_HEIGHT, &next) && next == NULL)
    {
        if (len != sizeof(uint8_t))
        {
            LOG_WRN("Unexpected stored height length %u", (unsigned)len);
            return -EINVAL;
        }

        uint8_t v;
        ssize_t rc = read_cb(cb_arg, &v, sizeof(v));
        if (rc < 0)
        {
            LOG_ERR("read_cb failed: %d", (int)rc);
            return (int)rc;
        }

        if (v < DISPLAY_HEIGHT_MIN || v > DISPLAY_HEIGHT_MAX)
        {
            LOG_WRN("Stored height %u out of range [%u,%u]; ignoring",
                    v, DISPLAY_HEIGHT_MIN, DISPLAY_HEIGHT_MAX);
            return 0;
        }

        s_height = v;
        s_height_valid = true;
        s_persisted_height = v;
        s_persisted_valid = true;
        LOG_INF("Loaded persisted display height: %u", v);
        return 0;
    }

    return -ENOENT;
}

SETTINGS_STATIC_HANDLER_DEFINE(mos_display, SETTINGS_ROOT,
                               NULL, display_settings_set, NULL, NULL);

int mos_display_settings_load(void)
{
    return settings_load_subtree(SETTINGS_ROOT);
}

static void flush_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    if (!s_height_valid)
    {
        return;
    }
    if (s_persisted_valid && s_persisted_height == s_height)
    {
        return;
    }

    uint8_t v = s_height;
    int rc = settings_save_one(KEY_HEIGHT_FULL, &v, sizeof(v));
    if (rc != 0)
    {
        LOG_ERR("Failed to persist display height %u: %d", v, rc);
        /* Leave s_persisted_* unchanged; a subsequent save_height will reschedule. */
        return;
    }
    s_persisted_height = v;
    s_persisted_valid = true;
    LOG_INF("Flushed display height %u to flash", v);
}

int mos_display_settings_save_height(uint8_t height)
{
    if (height < DISPLAY_HEIGHT_MIN || height > DISPLAY_HEIGHT_MAX)
    {
        return -EINVAL;
    }

    /* No change at all — nothing to do, leave any in-flight flush alone. */
    if (s_height_valid && s_height == height)
    {
        return 0;
    }

    s_height = height;
    s_height_valid = true;

    /* If the new value already matches flash (e.g. user reverted during the debounce
     * window), cancel any pending write — no flash burn for "did nothing in the end". */
    if (s_persisted_valid && s_persisted_height == height)
    {
        (void)k_work_cancel_delayable(&s_flush_work);
        return 0;
    }

    /* Debounce: a fresh request restarts the timer, so a slider burst collapses to one
     * flash write FLUSH_DEBOUNCE_MS after the last change. */
    (void)k_work_reschedule(&s_flush_work, K_MSEC(FLUSH_DEBOUNCE_MS));
    return 0;
}

bool mos_display_settings_get_height(uint8_t *out)
{
    if (!s_height_valid || out == NULL)
    {
        return false;
    }
    *out = s_height;
    return true;
}
