#ifndef MOS_DISPLAY_CAPTION_RENDERER_H_
#define MOS_DISPLAY_CAPTION_RENDERER_H_

#include <stdbool.h>
#include <stdint.h>

#include "../mos_display_main_scene.h"
#include "mos_display_config.h"

/* Stateless caption render: pick the appropriate font (CJK probe / ASCII fallback /
 * simsun override), then dispatch into scene->caption via show_caption_default or
 * show_caption_custom. The throttler owns dedup and last-rendered state. */
void mos_ui_caption_renderer_render(mos_ui_main_scene_t *scene,
                                     const char *text,
                                     uint32_t committed_seq);

/* Business translation language pair (drives auto font-language switching). */
int  mos_ui_caption_renderer_set_translation_pair(display_biz_lang_t src, display_biz_lang_t dst);
void mos_ui_caption_renderer_get_translation_pair(display_biz_lang_t *src, display_biz_lang_t *dst);

#endif /* MOS_DISPLAY_CAPTION_RENDERER_H_ */
