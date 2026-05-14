
cmake_minimum_required(VERSION 3.20.0)

# Note: custom driver module registration enabled for A6N integration
set(ZEPHYR_EXTRA_MODULES ${CMAKE_CURRENT_SOURCE_DIR}/custom_driver_module)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(nrf5340_ble_simulator)

# Add nanopb support for protobuf
list(APPEND CMAKE_MODULE_PATH ${ZEPHYR_BASE}/modules/nanopb)
include(nanopb)

add_subdirectory(src/mos_driver)
add_subdirectory(src/mos_components/mos_ble)
add_subdirectory(src/mos_components/mos_sysport)
# add_subdirectory(src/mos_components/mos_pdm)  # PDM mic path disabled - using GX8002 VAD
add_subdirectory(src/mos_components/mos_battery)
add_subdirectory(src/mos_components/mos_hinge_fold)
add_subdirectory(src/mos_components/mos_interrupt)
add_subdirectory(src/mos_components/mos_gx8002)  # GX8002 VAD path enabled
add_subdirectory(src/mos_components/mos_font_storage)
add_subdirectory(src/mos_components/mos_display)
add_subdirectory(src/mos_components/mos_jlink_usb_switch)
add_subdirectory(src/mos_components/mos_dfu_progress)
add_subdirectory(src/mos_components/mos_touch)
add_subdirectory(src/mos_components/mos_brightness)
add_subdirectory(src/mos_components/mos_watchdog)
add_subdirectory(src/protobuf)
add_subdirectory(src/proto)

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_sources(app PRIVATE
    src/main.c
    src/shell_font_storage.c
    src/shell_display_control.c
    src/shell_opt3006.c
    src/shell_iqs7211e_control.c
    src/shell_mcu_control.c
    src/shell_battery_control.c
    # src/shell_audio_control.c  # PDM audio shell disabled - using GX8002 VAD
    src/shell_gx8002_control.c
    src/shell_lsm6dsv16x.c
    src/shell_jlink_usb_switch.c
    src/shell_npm1300_led.c
    src/shell_watchdog_control.c
)

zephyr_library_include_directories(.)
