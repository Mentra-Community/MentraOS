#ifndef MOS_DISPLAY_TEST_SCENES_H_
#define MOS_DISPLAY_TEST_SCENES_H_

#include <lvgl.h>

void mos_ui_test_pattern_create_chess(lv_obj_t *screen, int square_size, int width, int height);
void mos_ui_test_pattern_create_horizontal_zebra(lv_obj_t *screen, int stripe_height, int width);
void mos_ui_test_pattern_create_vertical_zebra(lv_obj_t *screen, int stripe_width, int height);
void mos_ui_test_pattern_create_center_rectangle(lv_obj_t *screen, const lv_font_t *font);

#endif /* MOS_DISPLAY_TEST_SCENES_H_ */
