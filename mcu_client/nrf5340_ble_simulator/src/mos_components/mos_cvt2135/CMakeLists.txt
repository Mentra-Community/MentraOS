# @Author       : Cole
# @Date         : 2025-12-31 10:30:00
# @LastEditTime : 2025-12-31 10:30:00
# @FilePath     : CMakeLists.txt
# @Description  : Build rules for mos_cvt2135 component
# Copyright (c) MentraOS Contributors 2025
# SPDX-License-Identifier: Apache-2.0

# Add include directories for app and lib headers
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x)
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/lib)

# Add component source files to the application build
target_sources(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/app_cvt213x_main.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/app_cvt213x_porting.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/lib/cva_tws_dongle.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/lib/cva_tws_flash.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/lib/cva_tws_gesture.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/lib/cva_tws_i2c.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/lib/cva_tws_platform.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/lib/cva_tws_util.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app_cvt213x/app_cvt213x_shim.c
)
