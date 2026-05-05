#ifndef MOS_UI_XY_TEXT_VIEW_H_
#define MOS_UI_XY_TEXT_VIEW_H_

#include <stdbool.h>
#include <stdint.h>
#include <lvgl.h>

#include "main_scene.h"

void mos_ui_xy_text_view_create(lv_obj_t *parent);
void mos_ui_xy_text_view_destroy(void);
bool mos_ui_xy_text_view_exists(void);
void mos_ui_xy_text_view_invalidate(void);
void mos_ui_xy_text_view_clear(void);

/* Render XY-positioned text. If the standalone Pattern 5 container exists, draw there;
 * otherwise fall back to scene->caption.positioned (Pattern 4 overlay). */
void mos_ui_xy_text_view_render(mos_ui_main_scene_t *scene,
                                 uint16_t x, uint16_t y,
                                 const char *text,
                                 uint16_t font_size, uint32_t color);

#endif /* MOS_UI_XY_TEXT_VIEW_H_ */
