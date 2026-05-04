#ifndef MAIN_SCENE_H_
#define MAIN_SCENE_H_

#include "welcome/welcome_view.h"
#include "caption/caption_view.h"

typedef struct
{
    mos_ui_welcome_view_t welcome;
    mos_ui_caption_view_t caption;
} mos_ui_main_scene_t;

typedef struct
{
    mos_ui_welcome_view_cfg_t welcome;
    mos_ui_caption_view_cfg_t caption;
} mos_ui_main_scene_cfg_t;

mos_ui_main_scene_t mos_ui_main_scene_create(lv_obj_t *parent, const mos_ui_main_scene_cfg_t *cfg);
void mos_ui_main_scene_destroy(mos_ui_main_scene_t *scene);

#endif /* MAIN_SCENE_H_ */
