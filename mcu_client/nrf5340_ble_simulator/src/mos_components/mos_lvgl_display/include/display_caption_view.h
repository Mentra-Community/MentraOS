#ifndef DISPLAY_CAPTION_VIEW_H_
#define DISPLAY_CAPTION_VIEW_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <lvgl.h>

#include "display_config.h"
#include "mos_lvgl_display.h"

void display_caption_view_reset_state(void);
void display_caption_view_reset_text_cache(void);
void display_caption_view_detach(void);
void display_caption_view_ensure(lv_obj_t *screen, lv_obj_t *welcome_container);
void display_caption_view_destroy(void);
void display_caption_view_clear(void);
void display_caption_view_hide_xy_overlay(void);
void display_caption_view_set_welcome_scroll(bool welcome_active);
void display_caption_view_apply_config(lv_obj_t *screen, const display_config_t *config);
void display_caption_view_invalidate_visible(void);
void display_caption_view_scroll_bottom_visible(void);
size_t display_caption_view_state_size(void);
int display_caption_view_state_init(void *state, void *context);
int display_caption_view_state_deinit(void *state, void *context);

bool display_caption_view_has_last_text(void);
const char *display_caption_view_get_last_text(void);
void display_caption_view_invalidate_last_text(void);
bool display_caption_view_text_equals_last(const char *text);

void display_caption_view_render_text(const char *text_content, uint32_t committed_seq, display_biz_lang_t src_lang,
                                      display_biz_lang_t dst_lang, lv_obj_t *welcome_container);

lv_obj_t *display_caption_view_get_container(void);
lv_obj_t *display_caption_view_get_label(void);
lv_obj_t *display_caption_view_get_gbk_container(void);
lv_obj_t *display_caption_view_get_xy_overlay_container(void);

#endif /* DISPLAY_CAPTION_VIEW_H_ */
