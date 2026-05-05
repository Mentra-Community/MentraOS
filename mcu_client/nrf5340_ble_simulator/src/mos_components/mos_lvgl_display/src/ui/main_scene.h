#ifndef MAIN_SCENE_H_
#define MAIN_SCENE_H_

#include <lvgl.h>
#include "welcome/welcome_view.h"
#include "caption/caption_view.h"

typedef struct
{
    mos_ui_welcome_view_t welcome;
    mos_ui_caption_view_t caption;
} mos_ui_main_scene_t;

typedef struct
{
    int x;
    int y;
    int width;
    int height;
    int padding;
    lv_color_t bg_color;
    lv_color_t text_color;
    const lv_font_t *font;
    int line_spacing;
    int label_y_offset;
    const lv_font_t *dfu_font;
    lv_color_t dfu_bar_bg_color;
    lv_color_t dfu_bar_fill_color;
} mos_ui_main_scene_cfg_t;

mos_ui_main_scene_t mos_ui_main_scene_create(lv_obj_t *parent, const mos_ui_main_scene_cfg_t *cfg);
void mos_ui_main_scene_show_caption_default(mos_ui_main_scene_t *scene, const lv_font_t *font, const char *text);
void mos_ui_main_scene_show_caption_custom(mos_ui_main_scene_t *scene, const char *text,
                                            const lv_font_t *font_primary, const lv_font_t *font_fallback,
                                            lv_color_t text_color);
void mos_ui_main_scene_show_positioned(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_show_welcome(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_clear_welcome(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_clear_caption(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_clear_positioned(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_scroll_caption_to_bottom(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_set_caption_scroll_enabled(mos_ui_main_scene_t *scene, bool enabled);
void mos_ui_main_scene_destroy(mos_ui_main_scene_t *scene);

#endif /* MAIN_SCENE_H_ */
