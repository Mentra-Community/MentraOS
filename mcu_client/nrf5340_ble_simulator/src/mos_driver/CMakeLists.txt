

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE 
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_i2s_master.c
    # ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_gx8002.c  # GX8002/VAD off; PDM mic
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_opt3006.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_iqs7211a.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_lsm6dsv16x.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_npm1300_led.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_button.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_jlink_usb_switch.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_npm1300_ldsw.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_usb_detect.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_pdm.c
)