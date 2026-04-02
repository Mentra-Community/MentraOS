target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)

target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_jlink_usb_switch_app.c)
