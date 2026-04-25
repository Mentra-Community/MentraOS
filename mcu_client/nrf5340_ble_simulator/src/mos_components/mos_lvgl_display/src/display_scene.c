#include "display_scene.h"

#include <zephyr/kernel.h>

static K_MUTEX_DEFINE(s_display_scene_lock);
static display_scene_mode_t s_display_scene_mode = DISPLAY_SCENE_MODE_WELCOME;
static display_pattern_id_t s_display_pattern_id = DISPLAY_PATTERN_DEFAULT;
/**
 * @brief Resets the display scene state, clearing all mode and pattern data.
 */
void display_scene_reset(void)
{
    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    s_display_scene_mode = DISPLAY_SCENE_MODE_WELCOME;
    s_display_pattern_id = DISPLAY_PATTERN_DEFAULT;
    k_mutex_unlock(&s_display_scene_lock);
}

void display_scene_set_mode(display_scene_mode_t mode)
{
    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    s_display_scene_mode = mode;
    k_mutex_unlock(&s_display_scene_lock);
}

void display_scene_set_pattern(display_pattern_id_t pattern_id)
{
    if (!display_pattern_id_is_valid((int)pattern_id))
    {
        return;
    }

    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    s_display_pattern_id = pattern_id;
    k_mutex_unlock(&s_display_scene_lock);
}
