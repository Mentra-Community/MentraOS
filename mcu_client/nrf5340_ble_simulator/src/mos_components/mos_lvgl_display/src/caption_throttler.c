#include "caption_throttler.h"

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(caption_throttler, LOG_LEVEL_INF);

#define THROTTLE_MIN_INTERVAL_MS 250U
#define THROTTLE_MIN_AGE_MS 250U
#define BLOCKED_LOG_INTERVAL_MS 500U
#define STATS_WINDOW_MS 1000U

static K_MUTEX_DEFINE(s_lock);

/* Pending slot — written by ingest thread, read by service thread. */
static bool s_pending_valid = false;
static uint32_t s_pending_arrival_ms = 0U;
static uint32_t s_pending_seq = 0U;
static char s_pending_text[CAPTION_TEXT_MAX_CHARS];

/* Last committed text — for dedup and force_rerender. */
static bool s_last_valid = false;
static uint32_t s_last_seq = 0U;
static char s_last_text[CAPTION_TEXT_MAX_CHARS];

/* Throttle / log timing. */
static uint32_t s_last_apply_ms = 0U;
static uint32_t s_throttle_log_ms = 0U;

/* Stats counters. */
static uint32_t s_stats_window_start_ms = 0U;
static uint32_t s_rx_count = 0U;
static uint32_t s_commit_count = 0U;
static uint32_t s_throttle_skip_count = 0U;
static uint32_t s_dedup_skip_count = 0U;

void mos_caption_throttler_ingest(const char *text)
{
    if (text == NULL)
    {
        return;
    }

    size_t text_len = strlen(text);
    if (text_len >= CAPTION_TEXT_MAX_CHARS)
    {
        LOG_WRN("ingest text truncated from %u to %u chars",
                (unsigned int)text_len, CAPTION_TEXT_MAX_CHARS - 1U);
        text_len = CAPTION_TEXT_MAX_CHARS - 1U;
    }

    k_mutex_lock(&s_lock, K_FOREVER);
    s_pending_seq++;
    if (text_len > 0U)
    {
        memcpy(s_pending_text, text, text_len);
    }
    s_pending_text[text_len] = '\0';
    s_pending_valid = true;
    s_pending_arrival_ms = k_uptime_get_32();
    s_rx_count++;
    LOG_INF("ingest seq=%u len=%u", s_pending_seq, (unsigned int)text_len);
    k_mutex_unlock(&s_lock);
}

bool mos_caption_throttler_service(mos_caption_render_fn render_fn, void *user_data)
{
    if (render_fn == NULL)
    {
        return false;
    }

    char text[CAPTION_TEXT_MAX_CHARS];
    uint32_t seq = 0U;
    uint32_t arrival_ms = 0U;
    bool committed = false;

    k_mutex_lock(&s_lock, K_FOREVER);

    if (!s_pending_valid)
    {
        k_mutex_unlock(&s_lock);
        return false;
    }

    uint32_t now_ms = k_uptime_get_32();
    uint32_t elapsed_ms = now_ms - s_last_apply_ms;
    uint32_t age_ms = now_ms - s_pending_arrival_ms;
    bool throttle_ready = !s_last_apply_ms
                          || (elapsed_ms >= THROTTLE_MIN_INTERVAL_MS && age_ms >= THROTTLE_MIN_AGE_MS);

    if (!throttle_ready)
    {
        s_throttle_skip_count++;
        if ((now_ms - s_throttle_log_ms) >= BLOCKED_LOG_INTERVAL_MS)
        {
            s_throttle_log_ms = now_ms;
            LOG_INF("throttle seq=%u elapsed=%u age=%u",
                    s_pending_seq, elapsed_ms, age_ms);
        }
        k_mutex_unlock(&s_lock);
        return false;
    }

    /* Take pending into local. */
    strncpy(text, s_pending_text, sizeof(text) - 1U);
    text[sizeof(text) - 1U] = '\0';
    seq = s_pending_seq;
    arrival_ms = s_pending_arrival_ms;
    s_pending_valid = false;

    /* Dedup against last committed. */
    if (s_last_valid && strcmp(text, s_last_text) == 0)
    {
        s_dedup_skip_count++;
        k_mutex_unlock(&s_lock);
        return false;
    }

    /* Update last + timer before invoking render so concurrent ingests see consistent state. */
    strncpy(s_last_text, text, sizeof(s_last_text) - 1U);
    s_last_text[sizeof(s_last_text) - 1U] = '\0';
    s_last_seq = seq;
    s_last_valid = true;
    s_last_apply_ms = now_ms;
    s_commit_count++;
    committed = true;

    k_mutex_unlock(&s_lock);

    /* Render outside the lock — render_fn runs heavy LVGL work. */
    (void)arrival_ms;
    render_fn(text, seq, user_data);
    return committed;
}

bool mos_caption_throttler_force_rerender(mos_caption_render_fn render_fn, void *user_data)
{
    if (render_fn == NULL)
    {
        return false;
    }

    char text[CAPTION_TEXT_MAX_CHARS];
    uint32_t seq = 0U;

    k_mutex_lock(&s_lock, K_FOREVER);
    if (!s_last_valid)
    {
        k_mutex_unlock(&s_lock);
        return false;
    }
    strncpy(text, s_last_text, sizeof(text) - 1U);
    text[sizeof(text) - 1U] = '\0';
    seq = s_last_seq;
    k_mutex_unlock(&s_lock);

    render_fn(text, seq, user_data);
    return true;
}

bool mos_caption_throttler_has_pending(char *out_text, size_t out_size, uint32_t *out_seq)
{
    bool has = false;
    k_mutex_lock(&s_lock, K_FOREVER);
    if (s_pending_valid)
    {
        has = true;
        if (out_text != NULL && out_size > 0U)
        {
            strncpy(out_text, s_pending_text, out_size - 1U);
            out_text[out_size - 1U] = '\0';
        }
        if (out_seq != NULL)
        {
            *out_seq = s_pending_seq;
        }
    }
    k_mutex_unlock(&s_lock);
    return has;
}

void mos_caption_throttler_reset(void)
{
    k_mutex_lock(&s_lock, K_FOREVER);
    s_pending_valid = false;
    s_pending_arrival_ms = 0U;
    s_pending_seq = 0U;
    s_pending_text[0] = '\0';

    s_last_valid = false;
    s_last_seq = 0U;
    s_last_text[0] = '\0';

    s_last_apply_ms = 0U;
    s_throttle_log_ms = 0U;

    s_stats_window_start_ms = 0U;
    s_rx_count = 0U;
    s_commit_count = 0U;
    s_throttle_skip_count = 0U;
    s_dedup_skip_count = 0U;
    k_mutex_unlock(&s_lock);
}

void mos_caption_throttler_log_stats_if_due(void)
{
    uint32_t now_ms = k_uptime_get_32();

    k_mutex_lock(&s_lock, K_FOREVER);
    if (s_stats_window_start_ms == 0U)
    {
        s_stats_window_start_ms = now_ms;
        k_mutex_unlock(&s_lock);
        return;
    }

    uint32_t elapsed_ms = now_ms - s_stats_window_start_ms;
    if (elapsed_ms < STATS_WINDOW_MS)
    {
        k_mutex_unlock(&s_lock);
        return;
    }

    /* LOG_INF("rx/s=%u commit/s=%u throttle_skip/s=%u dedup_skip/s=%u window=%ums",
     *         s_rx_count, s_commit_count, s_throttle_skip_count, s_dedup_skip_count, elapsed_ms); */
    (void)elapsed_ms;

    s_stats_window_start_ms = now_ms;
    s_rx_count = 0U;
    s_commit_count = 0U;
    s_throttle_skip_count = 0U;
    s_dedup_skip_count = 0U;
    k_mutex_unlock(&s_lock);
}
