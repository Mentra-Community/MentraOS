#
# Copyright (c) 2018 Nordic Semiconductor
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#
cmake_minimum_required(VERSION 3.20.0)
list(APPEND EXTRA_ZEPHYR_MODULES
  ${CMAKE_CURRENT_SOURCE_DIR}/../custom_driver_module)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(nrf5340)

# Add nanopb support for protobuf
list(APPEND CMAKE_MODULE_PATH ${ZEPHYR_BASE}/modules/nanopb)
include(nanopb)

set(LVGL_DIR ${ZEPHYR_LVGL_MODULE_DIR})
FILE(GLOB app_sources src/*.c)
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/.)
target_include_directories(app PRIVATE ${LVGL_DIR}/demos/)

# NORDIC SDK APP START
target_sources(app PRIVATE
  src/main.c
  src/protobuf_handler.c
)

# Add protobuf sources when available
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/src/mentraos_ble.pb.c)
  target_sources(app PRIVATE src/mentraos_ble.pb.c)
endif()

add_subdirectory(src/BspLog)
add_subdirectory(src/mos_components/mos_sysport)
add_subdirectory(src/mos_components/mos_lvgl_display)


target_sources_ifdef(CONFIG_LV_USE_DEMO_BENCHMARK app PRIVATE
    ${LVGL_DIR}/demos/benchmark/assets/img_benchmark_avatar.c
    ${LVGL_DIR}/demos/benchmark/assets/img_benchmark_lvgl_logo_argb.c
    ${LVGL_DIR}/demos/benchmark/assets/img_benchmark_lvgl_logo_rgb.c
    ${LVGL_DIR}/demos/benchmark/assets/lv_font_benchmark_montserrat_12_compr_az.c.c
    ${LVGL_DIR}/demos/benchmark/assets/lv_font_benchmark_montserrat_16_compr_az.c.c
    ${LVGL_DIR}/demos/benchmark/assets/lv_font_benchmark_montserrat_28_compr_az.c.c
    ${LVGL_DIR}/demos/benchmark/lv_demo_benchmark.c
)

target_sources_ifdef(CONFIG_LV_USE_DEMO_WIDGETS app PRIVATE
    ${LVGL_DIR}/demos/widgets/assets/img_clothes.c
    ${LVGL_DIR}/demos/widgets/assets/img_demo_widgets_avatar.c
    ${LVGL_DIR}/demos/widgets/assets/img_demo_widgets_needle.c
    ${LVGL_DIR}/demos/widgets/assets/img_lvgl_logo.c
    ${LVGL_DIR}/demos/widgets/lv_demo_widgets.c
)

zephyr_library_include_directories(.)
# NORDIC SDK APP END
