#include "caption_state.h"

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(caption_state, LOG_LEVEL_INF);

static K_MUTEX_DEFINE(s_caption_state_lock);
static bool s_caption_pending_valid = false;// Whether there is a pending caption text that has not been taken yet；是否有一个待处理的字幕文本尚未被取出
static uint32_t s_caption_pending_arrival_ms = 0U;// The timestamp (in ms) when the pending caption text arrived；待处理字幕文本到达的时间戳（以毫秒为单位）
static uint32_t s_caption_pending_seq = 0U;// The sequence number of the pending caption text；待处理字幕文本的序列号
static char s_caption_pending_text[CAPTION_TEXT_MAX_CHARS];// The pending caption text；待处理的字幕文本
/**
 * @brief Resets the caption state, clearing all pending and committed data.
 */
void caption_state_reset(void)
{
    k_mutex_lock(&s_caption_state_lock, K_FOREVER);
    s_caption_pending_valid = false;
    s_caption_pending_arrival_ms = 0U;
    s_caption_pending_seq = 0U;
    s_caption_pending_text[0] = '\0';
    k_mutex_unlock(&s_caption_state_lock);
}
/**
 * @brief Ingests new caption text, updating the pending state.
 * @param text The new caption text to ingest.
 */
void caption_state_ingest(const char *text)
{
    size_t text_len;

    if (text == NULL)
    {
        return;
    }

    text_len = strlen(text);
    if (text_len == 0U)
    {
        return;
    }

    if (text_len >= CAPTION_TEXT_MAX_CHARS)
    {
        LOG_WRN("[STATE][CAPTION] text truncated from %u to %u chars",
                (unsigned int)text_len, CAPTION_TEXT_MAX_CHARS - 1U);
        text_len = CAPTION_TEXT_MAX_CHARS - 1U;
    }

    k_mutex_lock(&s_caption_state_lock, K_FOREVER);
    s_caption_pending_seq++;
    memcpy(s_caption_pending_text, text, text_len);
    s_caption_pending_text[text_len] = '\0';
    s_caption_pending_valid = true;
    s_caption_pending_arrival_ms = k_uptime_get_32();
    LOG_INF("[STATE][CAPTION] ingest seq=%u len=%u", s_caption_pending_seq, (unsigned int)text_len);
    k_mutex_unlock(&s_caption_state_lock);
}
/**
 * @brief Peeks at the latest pending caption text without clearing it.
 * @param out_text Buffer to receive the caption text.
 * @param out_size Size of the output buffer.
 * @param out_arrival_ms Optional pointer to receive the arrival timestamp (in ms).
 * @param out_seq Optional pointer to receive the sequence number.
 * @return true if there is pending caption text, false otherwise.
*/
bool caption_state_peek_latest(char *out_text, size_t out_size, uint32_t *out_arrival_ms, uint32_t *out_seq)
{
    bool has_text = false;

    if (out_text == NULL || out_size == 0U)
    {
        return false;
    }

    k_mutex_lock(&s_caption_state_lock, K_FOREVER);
    if (s_caption_pending_valid)
    {
        strncpy(out_text, s_caption_pending_text, out_size - 1U);
        out_text[out_size - 1U] = '\0';
        if (out_arrival_ms != NULL)
        {
            *out_arrival_ms = s_caption_pending_arrival_ms;
        }
        if (out_seq != NULL)
        {
            *out_seq = s_caption_pending_seq;
        }
        has_text = true;
    }
    k_mutex_unlock(&s_caption_state_lock);

    return has_text;
}
/**
 * @brief Takes the latest caption text, clearing the pending state.
 * @param out_text Buffer to receive the caption text.
 * @param out_size Size of the output buffer.
 * @param out_seq Pointer to store the sequence number.
 * @return true if there was pending caption text, false otherwise.
 */
bool caption_state_take_latest(char *out_text, size_t out_size, uint32_t *out_seq)
{
    bool has_text = false;

    if (out_text == NULL || out_size == 0U)
    {
        return false;
    }

    k_mutex_lock(&s_caption_state_lock, K_FOREVER);
    if (s_caption_pending_valid)
    {
        strncpy(out_text, s_caption_pending_text, out_size - 1U);
        out_text[out_size - 1U] = '\0';
        if (out_seq != NULL)
        {
            *out_seq = s_caption_pending_seq;
        }
        s_caption_pending_valid = false;
        has_text = true;
    }
    k_mutex_unlock(&s_caption_state_lock);

    return has_text;
}
