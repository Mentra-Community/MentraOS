
# @Author       : Cole
# @Date         : 2025-07-31 10:40:40
# @LastEditTime : 2025-07-31 17:32:17
# @FilePath     : CMakeLists.txt
# @Description  : 
# Copyright (c) MentraOS Contributors 2025 
# SPDX-License-Identifier: Apache-2.0
 

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/protocol_ble_process.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/protocol_ble_send.c)