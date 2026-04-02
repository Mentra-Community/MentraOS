#
# @Author       : XK
# @Date         : 2025-05-08 17:54:10
# @LastEditTime : 2025-07-14 15:12:31
# @FilePath     : CMakeLists.txt
# @Description  : 
# 
# Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 




target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_littlefs.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_board_mcu.c)  
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_icm42688p.c)
# target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_ict_15318.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_gx8002.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_jsa_1147.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp_key.c)