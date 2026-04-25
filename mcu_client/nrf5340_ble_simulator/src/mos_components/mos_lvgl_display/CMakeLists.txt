
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_lvgl_display.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui_framework.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui_runtime.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui_lvgl_adapter.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui_font_policy.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_config.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/caption_state.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/caption_pipeline.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_scene.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_welcome_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_caption_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_xy_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_test_view.c
)
