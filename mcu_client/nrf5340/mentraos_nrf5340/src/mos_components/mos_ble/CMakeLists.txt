#   @Author       : Cole
#   @Date         : 2025-07-31 10:40:40
#   @LastEditTime : 2025-07-31 16:40:16
#   @FilePath     : CMakeLists.txt
#   @Description  : 
#   Copyright (c) MentraOS Contributors 2025 
#   SPDX-License-Identifier: Apache-2.0
 

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)

target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_ble_service.c)