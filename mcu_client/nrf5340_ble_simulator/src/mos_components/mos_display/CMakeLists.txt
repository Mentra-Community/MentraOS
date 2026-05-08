
target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include/.
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_sources(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_display.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/mos_display_screen_utils.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_display_config.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_display_caption_throttler.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/mos_display_utf8.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/mos_display_custom_rendering.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/mos_display_color_utils.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/mos_display_dynamic_font_labels.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/mos_display_text_diag.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/test_ui/mos_display_test_scenes.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/mos_display_main_scene.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/mos_display_caption_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/mos_display_caption_renderer.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/components/mos_display_caption_custom_scrolling.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/components/mos_display_caption_default_scrolling.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/components/mos_display_caption_positioned.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/mos_display_welcome_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/components/mos_display_welcome_text.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/components/mos_display_dfu_status.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/components/mos_display_dfu_progress_bar.c
)
