#ifndef DISPLAY_XY_VIEW_H_
#define DISPLAY_XY_VIEW_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <lvgl.h>

#include "display_config.h"

void display_xy_view_reset_state(void);
void display_xy_view_detach(void);
void display_xy_view_ensure(lv_obj_t *screen);
void display_xy_view_clear(void);
void display_xy_view_apply_config(lv_obj_t *screen, const display_config_t *config);
void display_xy_view_invalidate_visible(void);
lv_obj_t *display_xy_view_get_container(void);
size_t display_xy_view_state_size(void);
int display_xy_view_state_init(void *state, void *context);
int display_xy_view_state_deinit(void *state, void *context);

void display_xy_view_update_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color,
                                 lv_obj_t *overlay_container, lv_obj_t *translation_container, bool *used_overlay);

#endif /* DISPLAY_XY_VIEW_H_ */
