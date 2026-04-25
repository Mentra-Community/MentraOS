#ifndef CAPTION_PIPELINE_H_
#define CAPTION_PIPELINE_H_

#include <stdbool.h>
#include <stdint.h>

typedef void (*caption_pipeline_render_cb_t)(const char *text_content, uint32_t committed_seq);

void caption_pipeline_init(caption_pipeline_render_cb_t render_cb);
void caption_pipeline_reset(void);
void caption_pipeline_ingest(const char *text_content);
bool caption_pipeline_service_pending(void);
void caption_pipeline_log_stats_if_due(void);

#endif /* CAPTION_PIPELINE_H_ */
