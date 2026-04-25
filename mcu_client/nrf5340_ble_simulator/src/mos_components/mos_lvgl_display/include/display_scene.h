#ifndef DISPLAY_SCENE_H_
#define DISPLAY_SCENE_H_

#include <stdbool.h>

#include "display_pattern.h"

typedef enum
{
    DISPLAY_SCENE_MODE_WELCOME = 0,
    DISPLAY_SCENE_MODE_TRANSLATION = 1,
    DISPLAY_SCENE_MODE_CAPTION = DISPLAY_SCENE_MODE_TRANSLATION,  /* Legacy alias kept for older internals */
    DISPLAY_SCENE_MODE_XY = 2,
    DISPLAY_SCENE_MODE_TEST = 3,
} display_scene_mode_t;

/*
 * Compatibility scene state for shell patterns, translation throttling gates, and
 * legacy display diagnostics. Business page flow should prefer ui_runtime /
 * ui_framework state instead of reading this directly.
 */
void display_scene_reset(void);
void display_scene_set_mode(display_scene_mode_t mode);
void display_scene_set_pattern(display_pattern_id_t pattern_id);

#endif /* DISPLAY_SCENE_H_ */
