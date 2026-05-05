
target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include/.
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_sources(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_lvgl_display.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/screen.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_config.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/caption_state.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_scene.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/utf8.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/custom_rendering.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/color_utils.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/dynamic_font_labels.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utils/text_diag.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/others/test_patterns.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/others/gbk_test_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/main_scene.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/caption_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/caption_renderer.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/components/custom_scrolling.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/components/default_scrolling.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/caption/components/positioned.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/welcome_view.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/components/welcome_text.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/components/dfu_status.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ui/welcome/components/dfu_progress_bar.c
)
