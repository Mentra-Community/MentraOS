#
# Copyright (c) 2024, Nordic Semiconductor ASA.
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#
cmake_policy(SET CMP0076 NEW)
set(CMAKE_CURRENT_SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR})
set(NRF_BOARD_SELECTED True)
set(NRF_TFM_BOARD ${ZEPHYR_NRF_MODULE_DIR}/modules/trusted-firmware-m/tfm_boards)

add_library(platform_ns STATIC)

set(partition_includes
    ${NRF_TFM_BOARD}/partition
    ${CMAKE_BINARY_DIR}/../zephyr/include/generated
)

set(board_includes
    ${CMAKE_BINARY_DIR}/../zephyr/misc/generated/syscalls_links/include
    ${ZEPHYR_NRF_MODULE_DIR}/include/tfm
    ${ZEPHYR_NRF_MODULE_DIR}/include
)

target_include_directories(platform_region_defs
    INTERFACE
        ${partition_includes}
)

target_include_directories(platform_ns
    PUBLIC
        ${partition_includes}
        ${board_includes}
)

# Disabling UART stdout not supported in NS Image, which is always built even when not needed.
target_sources(platform_ns
  PRIVATE
  $<$<NOT:$<BOOL:${PLATFORM_DEFAULT_UART_STDOUT}>>:${NRF_TFM_BOARD}/common/dummy_uart_stdout.c>
)

# Get the value of HAL_NORDIC_PATH
include(${CMAKE_CURRENT_LIST_DIR}/common/core/config_nordic_nrf_spe.cmake)
add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/common/${NRF_SOC_VARIANT} ${NRF_SOC_VARIANT})

target_include_directories(platform_ns
    PUBLIC
        ${CMAKE_CURRENT_LIST_DIR}
)

if(TFM_PARTITION_PLATFORM)
    target_compile_definitions(platform_ns
        PUBLIC
        FIRMWARE_INFO_MAGIC=${FIRMWARE_INFO_MAGIC}
        EXT_API_MAGIC=${EXT_API_MAGIC}
        NRF_CONFIG_CPU_FREQ_MHZ=${NRF_CONFIG_CPU_FREQ_MHZ}
    )

    target_sources(platform_ns
        PRIVATE
        ${NRF_TFM_BOARD}/src/tfm_ioctl_ns_api.c
    )
endif()

target_link_libraries(platform_ns
    PUBLIC
        platform_region_defs
)
