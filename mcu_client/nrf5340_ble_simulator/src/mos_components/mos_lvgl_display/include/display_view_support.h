#ifndef DISPLAY_VIEW_SUPPORT_H_
#define DISPLAY_VIEW_SUPPORT_H_

#include <lvgl.h>

#define DISPLAY_VIEW_CONTENT_YOFF 80

void display_ui_register_dynamic_label(lv_obj_t *label);
void display_ui_unregister_dynamic_label(lv_obj_t *label);
void display_ui_request_refresh(void);

#endif /* DISPLAY_VIEW_SUPPORT_H_ */
