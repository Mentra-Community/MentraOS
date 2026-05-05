#ifndef MOS_SCREEN_H_
#define MOS_SCREEN_H_

#include <stdint.h>
#include <lvgl.h>

/* Thin abstraction over the active LVGL screen. The display control plane uses these
 * helpers instead of calling lv_* APIs directly. The returned lv_obj_t* should be
 * treated opaquely — pass it to view/scene constructors, do not dereference. */

lv_obj_t *mos_screen_get_root(void);

/* Delete every direct child of the screen (yields the CPU between deletions). */
void mos_screen_clear_children(void);

/* Mark every direct child of the screen as dirty, without touching the screen itself. */
void mos_screen_invalidate_children(void);

/* Set the screen background to a solid opaque color. */
void mos_screen_set_background(lv_color_t color);

/* Mark the entire screen dirty (forces a full repaint on next refresh). */
void mos_screen_invalidate_full(void);

#endif /* MOS_SCREEN_H_ */
