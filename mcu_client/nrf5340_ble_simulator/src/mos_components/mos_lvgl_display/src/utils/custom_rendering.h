#ifndef CUSTOM_RENDERING_H_
#define CUSTOM_RENDERING_H_

#include <stddef.h>
#include <lvgl.h>

/*
 * Per-character UTF-8 text layout engine for LVGL.
 *
 * Decodes UTF-8 codepoints, queries glyph metrics from the provided fonts,
 * performs manual line wrapping, and places one LVGL label per character.
 *
 * Pool usage:
 *   - If pool is non-NULL, labels are acquired from the pool (grown on demand,
 *     excess hidden). The caller owns the pool array and must pass pool_used
 *     as an in/out parameter.
 *   - If pool is NULL, a new lv_label is created per character (no reuse).
 */
void mos_ui_custom_render(lv_obj_t *container,
                           lv_coord_t x, lv_coord_t y, lv_coord_t max_width,
                           const char *text,
                           const lv_font_t *font_primary,
                           const lv_font_t *font_fallback,
                           lv_color_t text_color,
                           lv_obj_t **pool, size_t pool_size, size_t *pool_used,
                           lv_coord_t *out_end_x, lv_coord_t *out_end_y,
                           size_t *out_byte_len);

#endif /* CUSTOM_RENDERING_H_ */
