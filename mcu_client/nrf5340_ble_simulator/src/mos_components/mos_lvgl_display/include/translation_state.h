#ifndef TRANSLATION_STATE_H_
#define TRANSLATION_STATE_H_

/*
 * Semantic wrapper over the historical caption state implementation.
 *
 * This keeps the public-facing meaning aligned with translation-page behavior
 * without forcing a risky rename of the underlying caption_state module.
 */
#include "caption_state.h"

#define TRANSLATION_TEXT_MAX_CHARS CAPTION_TEXT_MAX_CHARS

static inline void translation_state_reset(void)
{
    caption_state_reset();
}

static inline void translation_state_ingest(const char *text)
{
    caption_state_ingest(text);
}

static inline bool translation_state_peek_latest(char *out_text, size_t out_size, uint32_t *out_arrival_ms,
                                                 uint32_t *out_seq)
{
    return caption_state_peek_latest(out_text, out_size, out_arrival_ms, out_seq);
}

static inline bool translation_state_take_latest(char *out_text, size_t out_size, uint32_t *out_seq)
{
    return caption_state_take_latest(out_text, out_size, out_seq);
}

#endif /* TRANSLATION_STATE_H_ */
