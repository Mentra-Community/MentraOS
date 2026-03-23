
#   @Author       : XK
#   @Date         : 2025-07-03 11:06:01
#   @LastEditTime : 2025-07-26 11:06:25
#   @FilePath     : CMakeLists.txt
#   @Description  : 


target_include_directories(app PRIVATE .)
target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../custom_driver_module/drivers/display/lcd)

target_sources(app PRIVATE 
            ${CMAKE_CURRENT_SOURCE_DIR}/task_process.c
            ${CMAKE_CURRENT_SOURCE_DIR}/task_interrupt.c
            ${CMAKE_CURRENT_SOURCE_DIR}/task_lc3_codec.c
            ${CMAKE_CURRENT_SOURCE_DIR}/task_ble_receive.c
            )

