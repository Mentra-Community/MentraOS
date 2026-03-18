#
# @Author       : XK
# @Date         : 2025-05-08 17:54:10
# @LastEditTime : 2025-06-26 17:59:53
# @FilePath     : CMakeLists.txt
# @Description  : 
# 
# Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 




target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/protocol_image_stream.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/protocol_image_cache.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/protocol_image_flash.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/protocol_ble_process.c)
target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/protocol_ble_send.c)