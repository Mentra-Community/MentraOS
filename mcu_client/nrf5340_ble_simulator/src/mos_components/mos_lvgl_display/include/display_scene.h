#ifndef DISPLAY_SCENE_H_
#define DISPLAY_SCENE_H_

#include <stdbool.h>

typedef enum
{
    DISPLAY_SCENE_MODE_WELCOME = 0,
    DISPLAY_SCENE_MODE_CAPTION = 1,
    DISPLAY_SCENE_MODE_POSITIONED = 2,
    DISPLAY_SCENE_MODE_TEST = 3,
} display_scene_mode_t;

void display_scene_reset(void);
void display_scene_set_mode(display_scene_mode_t mode);
display_scene_mode_t display_scene_get_mode(void);
bool display_scene_is_welcome_active(void);
void display_scene_set_pattern(int pattern_id);
int display_scene_get_pattern(void);
bool display_scene_allows_caption_render(void);

#endif /* DISPLAY_SCENE_H_ */
