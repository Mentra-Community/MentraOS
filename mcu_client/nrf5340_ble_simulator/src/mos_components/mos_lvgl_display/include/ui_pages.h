#ifndef UI_PAGES_H_
#define UI_PAGES_H_

#include "display_pattern.h"
#include "ui_framework.h"

typedef struct
{
    int (*show_welcome)(void *context);
    int (*hide_welcome)(void *context);
    int (*refresh_welcome)(void *context);
    int (*show_translation)(void *context);
    int (*refresh_translation)(void *context);
    int (*show_xy)(void *context);
    int (*refresh_xy)(void *context);
    int (*show_test)(void *context);
    int (*on_language_changed)(ui_lang_t lang, void *context);
} ui_page_lifecycle_t;

int ui_pages_register_display_pages(const ui_page_lifecycle_t *lifecycle);

ui_page_type_t ui_pages_from_pattern(display_pattern_id_t pattern_id);
display_pattern_id_t ui_pages_default_pattern_for_page(ui_page_type_t page);
int ui_pages_apply_page_scene(ui_page_type_t page);
int ui_pages_apply_test_pattern_scene(display_pattern_id_t pattern_id);
void ui_pages_mark_test_context(void);
const char *ui_pages_name(ui_page_type_t page);

#endif /* UI_PAGES_H_ */
