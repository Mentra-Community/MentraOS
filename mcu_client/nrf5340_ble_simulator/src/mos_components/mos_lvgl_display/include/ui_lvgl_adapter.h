
#ifndef UI_LVGL_ADAPTER_H_
#define UI_LVGL_ADAPTER_H_

#include <stdint.h>
#include <lvgl.h>

#include "display_pattern.h"
#include "ui_framework.h"

typedef struct
{
    lv_obj_t *screen;
    display_pattern_id_t pattern_id;
    const ui_page_params_t *params;
} ui_lvgl_page_context_t;

typedef struct
{
    void (*prepare_welcome)(lv_obj_t *screen);  // Build welcome-page objects / 构建欢迎页对象
    void (*refresh_welcome)(void);
    void (*render_translation)(const char *text_content, uint32_t committed_seq);
} ui_lvgl_adapter_hooks_t;

int ui_lvgl_adapter_register_pages(const ui_lvgl_adapter_hooks_t *hooks);

#endif /* UI_LVGL_ADAPTER_H_ */
