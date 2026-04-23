#ifndef CAPTION_STATE_H_
#define CAPTION_STATE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CAPTION_TEXT_MAX_CHARS 512U

void caption_state_reset(void);
void caption_state_ingest(const char *text);
bool caption_state_peek_latest(char *out_text, size_t out_size, uint32_t *out_arrival_ms, uint32_t *out_seq);
bool caption_state_take_latest(char *out_text, size_t out_size, uint32_t *out_seq);

#endif /* CAPTION_STATE_H_ */
