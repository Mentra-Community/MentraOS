#ifndef DISPLAY_WELCOME_VIEW_H_
#define DISPLAY_WELCOME_VIEW_H_

#include <stdbool.h>
#include <stddef.h>
#include <lvgl.h>

#include "display_config.h"

void display_welcome_view_reset_state(void);
void display_welcome_view_reset_text_cache(void);
void display_welcome_view_detach(void);
void display_welcome_view_ensure(lv_obj_t *screen);
void display_welcome_view_restore(lv_obj_t *screen);
void display_welcome_view_update_battery(void);
void display_welcome_view_clear(void);
void display_welcome_view_apply_config(lv_obj_t *screen, const display_config_t *config);
void display_welcome_view_invalidate_visible(void);
size_t display_welcome_view_state_size(void);
int display_welcome_view_state_init(void *state, void *context);
int display_welcome_view_state_deinit(void *state, void *context);

bool display_welcome_view_is_active(void);
void display_welcome_view_set_active(bool active);
bool display_welcome_view_is_initializing(void);

lv_obj_t *display_welcome_view_get_container(void);
lv_obj_t *display_welcome_view_get_label(void);
lv_obj_t *display_welcome_view_get_dfu_status_label(void);
lv_obj_t *display_welcome_view_get_dfu_progress_bar(void);
lv_obj_t *display_welcome_view_get_dfu_progress_fill(void);
lv_coord_t display_welcome_view_get_dfu_progress_bar_width(void);

#endif /* DISPLAY_WELCOME_VIEW_H_ */
