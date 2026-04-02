
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_lvgl_display.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/display_config.c
)