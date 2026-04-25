#ifndef DISPLAY_TEST_VIEW_H_
#define DISPLAY_TEST_VIEW_H_

#include <stdbool.h>
#include <stddef.h>
#include <lvgl.h>
#include <zephyr/kernel.h>

#include "display_pattern.h"

void display_test_view_reset_state(void);
void display_test_view_detach(void);
display_pattern_id_t display_test_view_get_current_pattern(void);
int display_test_view_get_pattern_count(void);
void display_test_view_set_current_pattern(display_pattern_id_t pattern_id);
void display_test_view_show_pattern(lv_obj_t *screen, display_pattern_id_t pattern_id);
void display_test_view_show_gbk_chars(void);
void display_test_view_show_gbk_text(void);
size_t display_test_view_state_size(void);
int display_test_view_state_init(void *state, void *context);
int display_test_view_state_deinit(void *state, void *context);

#endif /* DISPLAY_TEST_VIEW_H_ */
