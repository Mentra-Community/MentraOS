#include "mos_display_dynamic_font_labels.h"

#include <string.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

#include "mos_display.h"  /* MAX_TEXT_LEN */

LOG_MODULE_REGISTER(dynamic_font_labels, LOG_LEVEL_DBG);

#define MOS_DYNAMIC_FONT_LABEL_MAX 16

static lv_obj_t *s_labels[MOS_DYNAMIC_FONT_LABEL_MAX] = {0};
static int s_label_count = 0;

void mos_dynamic_font_labels_add(lv_obj_t *label)
{
    if (label == NULL || s_label_count >= MOS_DYNAMIC_FONT_LABEL_MAX)
    {
        return;
    }

    for (int i = 0; i < s_label_count; i++)
    {
        if (s_labels[i] == label)
        {
            return;
        }
    }

    s_labels[s_label_count++] = label;
}

void mos_dynamic_font_labels_clear(void)
{
    memset(s_labels, 0, sizeof(s_labels));
    s_label_count = 0;
}

/* LVGL v9: aliasing internal label text into lv_label_set_text may skip relayout. Copy first. */
static void relayout_label_text(lv_obj_t *obj)
{
    if (obj == NULL || lv_obj_get_class(obj) != &lv_label_class)
    {
        return;
    }

    const char *txt = lv_label_get_text(obj);
    if (txt == NULL)
    {
        return;
    }

    char buf[MAX_TEXT_LEN + 1];
    strncpy(buf, txt, sizeof(buf) - 1U);
    buf[sizeof(buf) - 1U] = '\0';
    lv_label_set_text(obj, buf);
}

void mos_dynamic_font_labels_apply(const lv_font_t *new_font,
                                    mos_dynamic_font_skip_fn skip_fn,
                                    void *user_data)
{
    if (new_font == NULL)
    {
        LOG_WRN("new_font is NULL, skipping font update");
        return;
    }

    lv_coord_t dynamic_line_spacing = (lv_coord_t)(new_font->line_height * 30 / 100);
    LOG_DBG("Font height: %d, calculated line spacing: %d", new_font->line_height, dynamic_line_spacing);

    for (int i = 0; i < s_label_count; i++)
    {
        if (s_labels[i] != NULL)
        {
            lv_obj_set_style_text_font(s_labels[i], new_font, 0);
            lv_obj_set_style_text_line_space(s_labels[i], dynamic_line_spacing, 0);
            lv_obj_update_layout(s_labels[i]);
        }
    }

    for (int i = 0; i < s_label_count; i++)
    {
        if (s_labels[i] == NULL)
        {
            continue;
        }
        if (skip_fn != NULL && skip_fn(s_labels[i], user_data))
        {
            continue;
        }
        relayout_label_text(s_labels[i]);
    }
}
