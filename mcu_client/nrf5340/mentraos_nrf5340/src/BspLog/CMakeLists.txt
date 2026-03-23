
#  @Author       : Cole
#  @Date         : 2025-07-25 11:26:39
#  @LastEditTime : 2025-07-29 09:27:32
#  @FilePath     : CMakeLists.txt
#  @Description  : 
#  
#  Copyright (c) 2025 MentraOS Organization. All rights reserved.


target_include_directories(app PRIVATE .)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/bsp_log.c)