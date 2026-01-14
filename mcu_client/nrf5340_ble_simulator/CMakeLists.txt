#
# Copyright (c) 2018 Nordic Semiconductor
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause

cmake_minimum_required(VERSION 3.20.0)

# Note: custom driver module registration enabled for HLS12VGA integration
set(ZEPHYR_EXTRA_MODULES ${CMAKE_CURRENT_SOURCE_DIR}/custom_driver_module)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(nrf5340_ble_simulator)

# Add nanopb support for protobuf
list(APPEND CMAKE_MODULE_PATH ${ZEPHYR_BASE}/modules/nanopb)
include(nanopb)

# Custom driver module picked up via ZEPHYR_EXTRA_MODULES (module.yml)
add_subdirectory(src/mos_components/mos_pdm)
add_subdirectory(src/mos_components/mos_interrupt)
add_subdirectory(src/mos_components/mos_cvt2135)
add_subdirectory(src/mos_driver)

target_sources(app PRIVATE
    src/main.c
    src/protobuf_handler.c
    src/mentra_ble_service.c
    src/pdm_audio_stream.c
    src/lvgl_demo.c
    src/display_manager.c
    src/BspLog/bsp_log.c
    src/bsp_log_control.c
    src/shell_log_control.c
    src/shell_display_control.c
    src/shell_gx8002_control.c
    src/shell_spt513n_control.c
    src/shell_cvt213x_control.c
    src/mos_components/mos_sysport/src/bal_os.c
    src/mos_components/mos_lvgl_display/src/mos_lvgl_display.c
    src/mos_components/mos_lvgl_display/src/display_config.c
)

# Add protobuf sources when available
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/src/proto/mentraos_ble.pb.c)
  target_sources(app PRIVATE src/proto/mentraos_ble.pb.c)
  target_include_directories(app PRIVATE src/proto)
elseif(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/src/mentraos_ble.pb.c)
  target_sources(app PRIVATE src/mentraos_ble.pb.c)
endif()

target_include_directories(app PRIVATE
    src
    src/BspLog
    src/mos_components/mos_sysport/include
    src/mos_components/mos_lvgl_display/include
    custom_driver_module/drivers
)

