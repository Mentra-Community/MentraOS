#include "caption_pipeline.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "caption_state.h"
#include "display_caption_view.h"
#include "display_scene.h"
#include "ui_framework.h"
#include "ui_runtime.h"

LOG_MODULE_REGISTER(caption_pipeline, LOG_LEVEL_INF);

#define CAPTION_PIPELINE_THROTTLE_MS 250U

/*
 * caption_pipeline is the shared low-level text pipeline.
 *
 * It does not decide business meaning by itself. The current active page
 * (`UI_PAGE_CAPTION` or `UI_PAGE_TRANSLATION`) decides whether the same text
 * stream is being used as generic caption text or as translation text.
 * caption_pipeline 是共用的底层文本流水线。
 * 它本身不决定业务语义。当前活动页面（`UI_PAGE_CAPTION` 或 `UI_PAGE_TRANSLATION`）
 * 决定同一条文本流是在作为通用字幕显示，还是在作为翻译文本显示。
 */
static caption_pipeline_render_cb_t s_render_cb;
static uint32_t s_stats_window_start_ms = 0U;
static uint32_t s_rx_count = 0U;
static uint32_t s_commit_count = 0U;
static uint32_t s_throttle_skip_count = 0U;
static uint32_t s_dedup_skip_count = 0U;
static uint32_t s_render_last_skip_log_ms = 0U;
static uint32_t s_last_apply_ms = 0U;

static const char *caption_pipeline_target_label(void)
{
    switch (ui_framework_get_active_page())
    {
        case UI_PAGE_CAPTION:
            return "CAPTION";
        case UI_PAGE_TRANSLATION:
            return "TRANSLATION";
        default:
            return "TEXT";
    }
}

#if defined(CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG)
/* Support diagnostics: count hard line breaks in payload and print escaped preview (\\n visible). */
static void caption_pipeline_log_payload_diag(const char *text)
{
    if (text == NULL)
    {
        LOG_INF("[TEXT_PAYLOAD] (null)");
        return;
    }

    size_t len = strlen(text);
    size_t n_lf = 0U;
    size_t n_cr = 0U;
    int first_lf = -1;
    int first_cr = -1;
    const uint8_t *bytes = (const uint8_t *)text;

    for (size_t i = 0U; i < len; ++i)
    {
        if (bytes[i] == (uint8_t)'\n')
        {
            if (first_lf < 0)
            {
                first_lf = (int)i;
            }
            n_lf++;
        }
        if (bytes[i] == (uint8_t)'\r')
        {
            if (first_cr < 0)
            {
                first_cr = (int)i;
            }
            n_cr++;
        }
    }

#define TEXT_PAYLOAD_ESC_CAP 192U
    char esc[TEXT_PAYLOAD_ESC_CAP];
    size_t oi = 0U;
    const uint8_t *p = bytes;
    for (; *p != '\0' && oi + 6U < TEXT_PAYLOAD_ESC_CAP; ++p)
    {
        if (*p == (uint8_t)'\n')
        {
            esc[oi++] = '\\';
            esc[oi++] = 'n';
        }
        else if (*p == (uint8_t)'\r')
        {
            esc[oi++] = '\\';
            esc[oi++] = 'r';
        }
        else if (*p == (uint8_t)'\t')
        {
            esc[oi++] = '\\';
            esc[oi++] = 't';
        }
        else if (*p < 0x20u || *p == 0x7Fu)
        {
            int written = snprintf(esc + oi, TEXT_PAYLOAD_ESC_CAP - oi, "\\x%02x", (unsigned int)*p);
            if (written <= 0 || (size_t)written >= TEXT_PAYLOAD_ESC_CAP - oi)
            {
                break;
            }
            oi += (size_t)written;
        }
        else
        {
            esc[oi++] = (char)*p;
        }
    }
    esc[oi] = '\0';

    const char *trunc = (*p != '\0') ? "...(esc_trunc)" : "";

    LOG_INF("[TEXT_PAYLOAD] len=%zu LF=%zu CR=%zu first_LF_off=%d first_CR_off=%d esc=\"%s\"%s", len, n_lf, n_cr,
            first_lf, first_cr, esc, trunc);
#undef TEXT_PAYLOAD_ESC_CAP
}
#endif /* CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG */

void caption_pipeline_init(caption_pipeline_render_cb_t render_cb)
{
    s_render_cb = render_cb;
}

void caption_pipeline_reset(void)
{
    caption_state_reset();
    display_caption_view_reset_text_cache();
    s_stats_window_start_ms = 0U;
    s_rx_count = 0U;
    s_commit_count = 0U;
    s_throttle_skip_count = 0U;
    s_dedup_skip_count = 0U;
    s_render_last_skip_log_ms = 0U;
    s_last_apply_ms = 0U;
}

void caption_pipeline_ingest(const char *text_content)
{
    if (text_content == NULL)
    {
        LOG_ERR("Invalid text content pointer");
        return;
    }

    s_rx_count++;
    caption_pipeline_log_stats_if_due();

#if defined(CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG)
    caption_pipeline_log_payload_diag(text_content);
#endif

    caption_state_ingest(text_content);
}

static bool caption_pipeline_try_commit_pending(char *latest_text, size_t latest_text_size)
{
    uint32_t pending_arrival_ms = 0U;
    uint32_t pending_seq = 0U;
    bool has_pending = caption_state_peek_latest(latest_text, latest_text_size, &pending_arrival_ms, &pending_seq);
    if (!has_pending)
    {
        return false;
    }

    uint32_t now_ms = k_uptime_get_32();
    uint32_t elapsed_ms = now_ms - s_last_apply_ms;
    uint32_t age_ms = now_ms - pending_arrival_ms;
    bool throttle_ready = !s_last_apply_ms || (elapsed_ms >= CAPTION_PIPELINE_THROTTLE_MS && age_ms >= CAPTION_PIPELINE_THROTTLE_MS);

    if (throttle_ready)
    {
        if (!caption_state_take_latest(latest_text, latest_text_size, &pending_seq))
        {
            return false;
        }

        if (display_caption_view_text_equals_last(latest_text))
        {
            s_dedup_skip_count++;
            return false;
        }

        if (s_render_cb != NULL)
        {
            s_render_cb(latest_text, pending_seq);
        }
        s_commit_count++;
        s_last_apply_ms = k_uptime_get_32();
        return true;
    }

    s_throttle_skip_count++;
    if ((now_ms - s_render_last_skip_log_ms) >= 500U)
    {
        s_render_last_skip_log_ms = now_ms;
        LOG_INF("[RENDER][%s] throttle seq=%u elapsed=%u age=%u", caption_pipeline_target_label(), pending_seq,
                elapsed_ms, age_ms);
    }
    return false;
}

void caption_pipeline_log_stats_if_due(void)
{
    uint32_t now_ms = k_uptime_get_32();
    if (s_stats_window_start_ms == 0U)
    {
        s_stats_window_start_ms = now_ms;
        return;
    }

    uint32_t elapsed_ms = now_ms - s_stats_window_start_ms;
    if (elapsed_ms < 1000U)
    {
        return;
    }

    // LOG_INF("[PT150] rx/s=%u commit/s=%u throttle_skip/s=%u dedup_skip/s=%u window=%ums", s_rx_count,
    //         s_commit_count, s_throttle_skip_count, s_dedup_skip_count, elapsed_ms);

    s_stats_window_start_ms = now_ms;
    s_rx_count = 0U;
    s_commit_count = 0U;
    s_throttle_skip_count = 0U;
    s_dedup_skip_count = 0U;
}
/*
 * Service one round of pending text updates.
 * This function is called from the LVGL thread and only commits text when the
 * active page is a text-capable page.
 * 处理一轮待更新文本。
 * 该函数由 LVGL 线程调用，只有当前活动页允许文本显示时才真正提交渲染。
 */
bool caption_pipeline_service_pending(void)
{
    static char latest_text[CAPTION_TEXT_MAX_CHARS];
    bool committed;
    uint32_t now_ms = k_uptime_get_32();
    uint32_t pending_arrival_ms = 0U;
    uint32_t pending_seq = 0U;
    if (!ui_runtime_translation_render_is_allowed())
    {
        if (caption_state_peek_latest(latest_text, sizeof(latest_text), &pending_arrival_ms, &pending_seq)
            && ((now_ms - s_render_last_skip_log_ms) >= 1000U))
        {
            s_render_last_skip_log_ms = now_ms;
            LOG_INF("[RENDER][%s] blocked seq=%u page=%d pattern=%d", caption_pipeline_target_label(), pending_seq,
                    (int)ui_framework_get_active_page(), ui_runtime_current_pattern());
        }
        return false;
    }
    committed = caption_pipeline_try_commit_pending(latest_text, sizeof(latest_text));
    caption_pipeline_log_stats_if_due();
    return committed;
}
