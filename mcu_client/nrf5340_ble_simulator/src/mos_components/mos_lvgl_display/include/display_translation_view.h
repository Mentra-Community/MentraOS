#ifndef DISPLAY_TRANSLATION_VIEW_H_
#define DISPLAY_TRANSLATION_VIEW_H_

/*
 * Semantic wrapper over the historical caption view implementation.
 *
 * New page-level code should prefer display_translation_view_* names so the
 * intent stays aligned with the translation page, while the low-level
 * implementation can remain in display_caption_view.* for now.
 */
#include "display_caption_view.h"

static inline void display_translation_view_reset_state(void)
{
    display_caption_view_reset_state();
}

static inline void display_translation_view_reset_text_cache(void)
{
    display_caption_view_reset_text_cache();
}

static inline void display_translation_view_detach(void)
{
    display_caption_view_detach();
}

static inline void display_translation_view_ensure(lv_obj_t *screen, lv_obj_t *welcome_container)
{
    display_caption_view_ensure(screen, welcome_container);
}

static inline void display_translation_view_destroy(void)
{
    display_caption_view_destroy();
}

static inline void display_translation_view_clear(void)
{
    display_caption_view_clear();
}

static inline void display_translation_view_hide_xy_overlay(void)
{
    display_caption_view_hide_xy_overlay();
}

static inline void display_translation_view_set_welcome_scroll(bool welcome_active)
{
    display_caption_view_set_welcome_scroll(welcome_active);
}

static inline void display_translation_view_apply_config(lv_obj_t *screen, const display_config_t *config)
{
    display_caption_view_apply_config(screen, config);
}

static inline void display_translation_view_invalidate_visible(void)
{
    display_caption_view_invalidate_visible();
}

static inline void display_translation_view_scroll_bottom_visible(void)
{
    display_caption_view_scroll_bottom_visible();
}

static inline size_t display_translation_view_state_size(void)
{
    return display_caption_view_state_size();
}

static inline int display_translation_view_state_init(void *state, void *context)
{
    return display_caption_view_state_init(state, context);
}

static inline int display_translation_view_state_deinit(void *state, void *context)
{
    return display_caption_view_state_deinit(state, context);
}

static inline bool display_translation_view_has_last_text(void)
{
    return display_caption_view_has_last_text();
}

static inline const char *display_translation_view_get_last_text(void)
{
    return display_caption_view_get_last_text();
}

static inline void display_translation_view_invalidate_last_text(void)
{
    display_caption_view_invalidate_last_text();
}

static inline bool display_translation_view_text_equals_last(const char *text)
{
    return display_caption_view_text_equals_last(text);
}

static inline void display_translation_view_render_text(const char *text_content, uint32_t committed_seq,
                                                        display_biz_lang_t src_lang, display_biz_lang_t dst_lang,
                                                        lv_obj_t *welcome_container)
{
    display_caption_view_render_text(text_content, committed_seq, src_lang, dst_lang, welcome_container);
}

static inline lv_obj_t *display_translation_view_get_container(void)
{
    return display_caption_view_get_container();
}

static inline lv_obj_t *display_translation_view_get_label(void)
{
    return display_caption_view_get_label();
}

static inline lv_obj_t *display_translation_view_get_gbk_container(void)
{
    return display_caption_view_get_gbk_container();
}

static inline lv_obj_t *display_translation_view_get_xy_overlay_container(void)
{
    return display_caption_view_get_xy_overlay_container();
}

#endif /* DISPLAY_TRANSLATION_VIEW_H_ */
