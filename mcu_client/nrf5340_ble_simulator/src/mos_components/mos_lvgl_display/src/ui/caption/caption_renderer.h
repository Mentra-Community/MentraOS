#ifndef MOS_UI_CAPTION_RENDERER_H_
#define MOS_UI_CAPTION_RENDERER_H_

#include <stdbool.h>
#include <stdint.h>

#include "../main_scene.h"
#include "display_config.h"

void mos_ui_caption_renderer_render(mos_ui_main_scene_t *scene,
                                     const char *text,
                                     uint32_t committed_seq);

/* Re-render whatever is currently cached (or empty if none), bypassing dedup.
 * Used after a font change so the caption picks up the new glyph metrics. */
void mos_ui_caption_renderer_rerender(mos_ui_main_scene_t *scene);

/* Last-rendered text cache (used for dedup + font-change re-render). */
void mos_ui_caption_renderer_invalidate_cache(void);
void mos_ui_caption_renderer_reset_cache(void);
bool mos_ui_caption_renderer_has_cache(void);
const char *mos_ui_caption_renderer_get_cache(void);

/* Business translation language pair (drives auto font-language switching). */
int  mos_ui_caption_renderer_set_translation_pair(display_biz_lang_t src, display_biz_lang_t dst);
void mos_ui_caption_renderer_get_translation_pair(display_biz_lang_t *src, display_biz_lang_t *dst);

#endif /* MOS_UI_CAPTION_RENDERER_H_ */
