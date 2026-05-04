#include "main_scene.h"

#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(main_scene, LOG_LEVEL_DBG);

mos_ui_main_scene_t mos_ui_main_scene_create(lv_obj_t *parent, const mos_ui_main_scene_cfg_t *cfg)
{
    mos_ui_main_scene_t scene = {0};

    if (!parent || !cfg)
    {
        LOG_ERR("main_scene: invalid args");
        return scene;
    }

    scene.welcome = mos_ui_welcome_view_create(parent, &cfg->welcome);
    scene.caption = mos_ui_caption_view_create(parent, &cfg->caption);

    LOG_DBG("main_scene created");
    return scene;
}

void mos_ui_main_scene_destroy(mos_ui_main_scene_t *scene)
{
    if (!scene)
    {
        return;
    }

    mos_ui_welcome_view_destroy(&scene->welcome);
    mos_ui_caption_view_destroy(&scene->caption);
}
