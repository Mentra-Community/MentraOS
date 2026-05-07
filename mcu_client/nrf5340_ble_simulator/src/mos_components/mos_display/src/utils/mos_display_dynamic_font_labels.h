#ifndef MOS_DISPLAY_DYNAMIC_FONT_LABELS_H_
#define MOS_DISPLAY_DYNAMIC_FONT_LABELS_H_

#include <stdbool.h>
#include <lvgl.h>

typedef bool (*mos_dynamic_font_skip_fn)(lv_obj_t *label, void *user_data);

void mos_dynamic_font_labels_add(lv_obj_t *label);
void mos_dynamic_font_labels_clear(void);

/* Apply new_font to all registered labels: set font + line spacing, then relayout via copied set_text.
 * skip_fn(label, user_data) — return true to skip the relayout pass for that label (font+spacing are still set). */
void mos_dynamic_font_labels_apply(const lv_font_t *new_font,
                                    mos_dynamic_font_skip_fn skip_fn,
                                    void *user_data);

#endif /* MOS_DISPLAY_DYNAMIC_FONT_LABELS_H_ */
