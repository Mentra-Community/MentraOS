#   @Author       : Cole
#   @Date         : 2025-12-04
#   @LastEditTime : 2025-12-04
#   @FilePath     : CMakeLists.txt
#   @Description  : 
#   Copyright (c) MentraOS Contributors 2025 
#   SPDX-License-Identifier: Apache-2.0

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)

target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/interrupt_handler.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/vad_interrupt_handler.c)

