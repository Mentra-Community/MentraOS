# @Author       : Cole
# @Date         : 2025-07-31 10:40:40
# @LastEditTime : 2025-07-31 17:25:25
# @FilePath     : CMakeLists.txt
# @Description  : 
# Copyright (c) MentraOS Contributors 2025 
# SPDX-License-Identifier: Apache-2.0
 


target_include_directories(app PRIVATE .)
target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../custom_driver_module/drivers/display/lcd)

target_sources(app PRIVATE 
            ${CMAKE_CURRENT_SOURCE_DIR}/task_process.c
            ${CMAKE_CURRENT_SOURCE_DIR}/task_interrupt.c
            ${CMAKE_CURRENT_SOURCE_DIR}/task_lc3_codec.c
            ${CMAKE_CURRENT_SOURCE_DIR}/task_ble_receive.c
            )

