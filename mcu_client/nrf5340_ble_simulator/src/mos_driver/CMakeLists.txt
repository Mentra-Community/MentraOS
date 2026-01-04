#   @Author       : Cole
#   @Date         : 2025-07-31 10:40:40
#   @LastEditTime : 2025-07-31 17:14:48
#   @FilePath     : CMakeLists.txt
#   @Description  : 
#   Copyright (c) MentraOS Contributors 2025 
#   SPDX-License-Identifier: Apache-2.0



target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bspal_audio_i2s.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_gx8002.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/gx8002_update.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/stp513n.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/cvt213x.c)