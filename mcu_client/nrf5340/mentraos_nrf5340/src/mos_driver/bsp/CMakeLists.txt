#   @Author       : Cole
#   @Date         : 2025-07-31 10:40:40
#   @LastEditTime : 2025-07-31 17:08:07
#   @FilePath     : CMakeLists.txt
#   @Description  : 
#   Copyright (c) MentraOS Contributors 2025 
#   SPDX-License-Identifier: Apache-2.0
 



target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_littlefs.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_board_mcu.c)  
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_icm42688p.c)
# target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_ict_15318.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_gx8002.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_jsa_1147.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_key.c)