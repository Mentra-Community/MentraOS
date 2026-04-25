#ifndef UI_RUNTIME_H_
#define UI_RUNTIME_H_

#include "display_pattern.h"
#include "ui_framework.h"

/*
 * Thin runtime facade for LVGL-thread page operations.
 *
 * External threads should enqueue display commands first; these functions are
 * intended to run from the display runtime/LVGL thread.
 */
int ui_runtime_show_page(ui_page_type_t page, const ui_page_params_t *params, void *context);
int ui_runtime_show_welcome(void *context);
int ui_runtime_show_caption(const ui_page_params_t *params, void *context);
int ui_runtime_show_translation(const ui_page_params_t *params, void *context);
int ui_runtime_show_xy(const ui_page_params_t *params, void *context);
int ui_runtime_push_page(ui_page_type_t page, const ui_page_params_t *params, void *context);
int ui_runtime_replace_page(ui_page_type_t page, const ui_page_params_t *params, void *context);
int ui_runtime_show_pattern(display_pattern_id_t pattern_id, void *context);
int ui_runtime_show_test_pattern(display_pattern_id_t pattern_id, void *context);
int ui_runtime_go_back(void *context);
int ui_runtime_refresh(void *context);
int ui_runtime_dispatch_event(const ui_event_t *event, void *context);
bool ui_runtime_page_is_active(ui_page_type_t page);
bool ui_runtime_translation_render_is_allowed(void);
display_pattern_id_t ui_runtime_current_pattern(void);
void ui_runtime_mark_test_context(void);

#endif /* UI_RUNTIME_H_ */
