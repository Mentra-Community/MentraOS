#ifndef TRANSLATION_PIPELINE_H_
#define TRANSLATION_PIPELINE_H_

/*
 * Semantic wrapper over the historical caption pipeline implementation.
 *
 * Use this header from new code when the business meaning is "translation
 * text", while the underlying implementation still lives in caption_* files.
 */
#include "caption_pipeline.h"

typedef caption_pipeline_render_cb_t translation_pipeline_render_cb_t;

static inline void translation_pipeline_init(translation_pipeline_render_cb_t render_cb)
{
    caption_pipeline_init(render_cb);
}

static inline void translation_pipeline_reset(void)
{
    caption_pipeline_reset();
}

static inline void translation_pipeline_ingest(const char *text_content)
{
    caption_pipeline_ingest(text_content);
}

static inline bool translation_pipeline_service_pending(void)
{
    return caption_pipeline_service_pending();
}

static inline void translation_pipeline_log_stats_if_due(void)
{
    caption_pipeline_log_stats_if_due();
}

#endif /* TRANSLATION_PIPELINE_H_ */
