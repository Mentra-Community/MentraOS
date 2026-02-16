/*
 * Display brightness: level (0-100%), auto brightness (OPT3006), and A6N hardware control.
 * Protobuf and others call into this module only; no dependency on protobuf here.
 */

#ifndef MOS_DISPLAY_BRIGHTNESS_H_
#define MOS_DISPLAY_BRIGHTNESS_H_

#include <stdbool.h>
#include <stdint.h>

/** Start the auto-brightness thread (call after opt3006_initialize()). */
void display_brightness_thread_start(void);

/** Set brightness level 0-100%; disables auto brightness. */
void display_brightness_set_level(uint32_t level);

/** Enable or disable auto brightness (sensor-driven). */
void display_brightness_set_auto_enabled(bool enabled);

/** Current brightness level 0-100%. */
uint32_t display_brightness_get_level(void);

/** Whether auto brightness is enabled. */
bool display_brightness_get_auto_enabled(void);

#endif /* MOS_DISPLAY_BRIGHTNESS_H_ */
