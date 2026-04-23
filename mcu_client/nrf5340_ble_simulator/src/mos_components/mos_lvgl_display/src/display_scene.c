#include "display_scene.h"

#include <zephyr/kernel.h>

static K_MUTEX_DEFINE(s_display_scene_lock);
static display_scene_mode_t s_display_scene_mode = DISPLAY_SCENE_MODE_WELCOME;
static int s_display_pattern_id = 4;
/**
 * @brief Resets the display scene state, clearing all mode and pattern data.
 */
void display_scene_reset(void)
{
    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    s_display_scene_mode = DISPLAY_SCENE_MODE_WELCOME;
    s_display_pattern_id = 4;
    k_mutex_unlock(&s_display_scene_lock);
}

void display_scene_set_mode(display_scene_mode_t mode)
{
    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    s_display_scene_mode = mode;
    k_mutex_unlock(&s_display_scene_lock);
}

display_scene_mode_t display_scene_get_mode(void)
{
    display_scene_mode_t mode;

    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    mode = s_display_scene_mode;
    k_mutex_unlock(&s_display_scene_lock);

    return mode;
}

bool display_scene_is_welcome_active(void)
{
    return display_scene_get_mode() == DISPLAY_SCENE_MODE_WELCOME;
}

void display_scene_set_pattern(int pattern_id)
{
    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    s_display_pattern_id = pattern_id;
    k_mutex_unlock(&s_display_scene_lock);
}

int display_scene_get_pattern(void)
{
    int pattern_id;

    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    pattern_id = s_display_pattern_id;
    k_mutex_unlock(&s_display_scene_lock);

    return pattern_id;
}

bool display_scene_allows_caption_render(void)
{
    bool allowed;

    k_mutex_lock(&s_display_scene_lock, K_FOREVER);
    allowed = (s_display_pattern_id == 4) 
            && (s_display_scene_mode == DISPLAY_SCENE_MODE_WELCOME || s_display_scene_mode == DISPLAY_SCENE_MODE_CAPTION);
    k_mutex_unlock(&s_display_scene_lock);

    return allowed;
}
