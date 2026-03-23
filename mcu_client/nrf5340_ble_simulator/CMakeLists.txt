#
# Copyright (c) 2018 Nordic Semiconductor
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause

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
add_subdirectory(src/mos_components/mos_pdm)
add_subdirectory(src/mos_components/mos_battery)
add_subdirectory(src/mos_components/mos_button)
add_subdirectory(src/mos_components/mos_interrupt)
add_subdirectory(src/mos_components/mos_lvgl_display)
add_subdirectory(src/mos_components/mos_jlink_usb_switch)
add_subdirectory(src/mos_components/mos_dfu_progress)
add_subdirectory(src/protobuf)
add_subdirectory(src/proto)

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_sources(app PRIVATE
    src/main.c
    src/shell_display_control.c
    src/shell_opt3006.c
    src/shell_battery_control.c
    src/shell_audio_control.c
    src/shell_lsm6dsv16x.c
    src/shell_jlink_usb_switch.c
    src/shell_npm1300_led.c
)

zephyr_library_include_directories(.)