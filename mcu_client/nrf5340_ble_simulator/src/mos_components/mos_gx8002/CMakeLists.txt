# GX8002 application layer: I2S slave (VAD audio path) + firmware OTA update

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/app/include)

target_sources(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/app/src/mos_i2s_slave.c
    ${CMAKE_CURRENT_SOURCE_DIR}/app/src/gx8002_update.c
)
