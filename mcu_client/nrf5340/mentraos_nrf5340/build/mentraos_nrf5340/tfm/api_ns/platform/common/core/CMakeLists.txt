#
# Copyright (c) 2024, Arm Limited. All rights reserved.
# Copyright (c) 2023, Nordic Semiconductor ASA.
#
# SPDX-License-Identifier: BSD-3-Clause
#

# This file is exported to NS side during CMake installation phase and renamed
# to CMakeLists.txt. It instructs how to build a platform on non-secture side.
# The structure and sources list are fully platform specific.

target_compile_definitions(platform_region_defs
    INTERFACE
        $<$<BOOL:${NULL_POINTER_EXCEPTION_DETECTION}>:NULL_POINTER_EXCEPTION_DETECTION>
        $<$<BOOL:${NRF_NS_STORAGE}>:NRF_NS_STORAGE>
        $<$<BOOL:${NRF_NS_SECONDARY}>:NRF_NS_SECONDARY>
)

# Startup sources should be put in the executable
target_sources(tfm_ns
    PRIVATE
        startup.c
        $<$<C_COMPILER_ID:GNU>:${CMAKE_CURRENT_SOURCE_DIR}/startup_${target}.c>
)

# Additional NS API sources
target_sources(tfm_api_ns
    PRIVATE
        $<$<BOOL:${TFM_PARTITION_PLATFORM}>:${CONFIG_SPE_PATH}/interface/src/tfm_ioctl_core_ns_api.c>
)

target_sources(platform_ns
    PRIVATE
        cmsis_drivers/Driver_USART.c
        ${HAL_NORDIC_PATH}/nrfx/drivers/src/nrfx_uarte.c
        nrfx_glue.c
        $<$<BOOL:${TEST_PSA_API}>:${CMAKE_CURRENT_SOURCE_DIR}/pal_plat_test.c>
)

# Ensure that debug symbols for SystemInit are added.
#
# It has been observed that without this patch, debug symbols for
# SystemInit go missing.
#
# This code is not expected to affect the hex file as SystemInit is
# already required for any image that runs on a nrf device.
target_link_libraries(platform_ns
    PUBLIC
	-Wl,--undefined=SystemInit
)

target_include_directories(platform_ns
    PUBLIC
        .
        common
        ${HAL_NORDIC_PATH}/nrfx
        ${HAL_NORDIC_PATH}/nrfx/mdk
        ${HAL_NORDIC_PATH}/nrfx/drivers/include
        ${PLATFORM_DIR}/include
        ${PLATFORM_DIR}/ext/cmsis/Include
        ${PLATFORM_DIR}/ext/cmsis/Include/m-profile
        ${PLATFORM_DIR}/ext/driver
        ${PLATFORM_DIR}/ext/common
        services/include
)

target_compile_definitions(platform_ns
    PUBLIC
        $<$<BOOL:${TEST_PSA_API}>:PSA_API_TEST_ENABLED>
        NRF_TRUSTZONE_NONSECURE
        DOMAIN_NS=1
)

target_compile_definitions(platform_ns
  PUBLIC
  # We don't need to trim the device in the non-secure image because it
  # is the secure image's responsiblity to do this.
  NRF_DISABLE_FICR_TRIMCNF
  # The glitch detector can only be configured from a secure image so
  # we need to skip this configuration.
  NRF_SKIP_GLITCHDETECTOR_DISABLE
)

