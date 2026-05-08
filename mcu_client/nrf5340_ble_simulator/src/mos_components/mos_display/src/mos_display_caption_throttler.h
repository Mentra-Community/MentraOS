#ifndef MOS_DISPLAY_CAPTION_THROTTLER_H_
#define MOS_DISPLAY_CAPTION_THROTTLER_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CAPTION_TEXT_MAX_CHARS 512U

/* Render hook invoked by the throttler when it decides a text is ready to commit.
 * `seq` is the ingest sequence; useful for log correlation. */
typedef void (*mos_caption_render_fn)(const char *text, uint32_t seq, void *user_data);

/* BLE/protobuf thread: stash the latest caption text. Replaces any prior pending text;
 * ingest rate is decoupled from render rate. */
void mos_caption_throttler_ingest(const char *text);

/* LVGL thread, called every tick. Decides under throttle/dedup rules whether to commit
 * the pending text. On a yes, invokes render_fn and remembers what was rendered.
 * Returns true if render_fn was invoked. */
bool mos_caption_throttler_service(mos_caption_render_fn render_fn, void *user_data);

/* Re-render the last committed text bypassing throttle and dedup (e.g. after a font swap
 * where glyph metrics changed). No-op (returns false) if nothing has been committed yet. */
bool mos_caption_throttler_force_rerender(mos_caption_render_fn render_fn, void *user_data);

/* Returns true when there is text waiting to be committed. Optionally returns a copy of
 * that text and its seq — used by the scene-gate "blocked" log path. */
bool mos_caption_throttler_has_pending(char *out_text, size_t out_size, uint32_t *out_seq);

/* Reset every piece of state: pending, last-committed, throttle timer, all counters. */
void mos_caption_throttler_reset(void);

/* Once-per-second stats log; safe (and intended) to call every loop iteration. */
void mos_caption_throttler_log_stats_if_due(void);

#endif /* MOS_DISPLAY_CAPTION_THROTTLER_H_ */
