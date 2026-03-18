#-------------------------------------------------------------------------------
# Copyright (c) 2023-2024, Arm Limited. All rights reserved.
#
# SPDX-License-Identifier: BSD-3-Clause
#
#-------------------------------------------------------------------------------
cmake_minimum_required(VERSION 3.21)

# This CMake script is prepard by TF-M for building the non-secure side
# application and not used in secure build a tree being for export only.
# This file is renamed to spe/CMakeList.txt during installation phase

include(spe_config)
include(spe_export)

set_target_properties(tfm_config psa_interface psa_crypto_config PROPERTIES IMPORTED_GLOBAL True)
target_link_libraries(tfm_config INTERFACE psa_interface)

# In actual NS integration, NS side build should include the source files
# exported by TF-M build.
set(INTERFACE_SRC_DIR    ${CMAKE_CURRENT_LIST_DIR}/interface/src)
set(INTERFACE_INC_DIR    ${CMAKE_CURRENT_LIST_DIR}/interface/include)

add_library(tfm_api_ns STATIC)

target_sources(tfm_api_ns
    PUBLIC
        $<$<BOOL:${TFM_PARTITION_PLATFORM}>:${INTERFACE_SRC_DIR}/tfm_platform_api.c>
        $<$<BOOL:${TFM_PARTITION_PROTECTED_STORAGE}>:${INTERFACE_SRC_DIR}/tfm_ps_api.c>
        $<$<BOOL:${TFM_PARTITION_INTERNAL_TRUSTED_STORAGE}>:${INTERFACE_SRC_DIR}/tfm_its_api.c>
        $<$<BOOL:${TFM_PARTITION_CRYPTO}>:${INTERFACE_SRC_DIR}/tfm_crypto_api.c>
        $<$<BOOL:${TFM_PARTITION_INITIAL_ATTESTATION}>:${INTERFACE_SRC_DIR}/tfm_attest_api.c>
        $<$<BOOL:${TFM_PARTITION_FIRMWARE_UPDATE}>:${INTERFACE_SRC_DIR}/tfm_fwu_api.c>
)

# Include interface headers exported by TF-M
if(PSA_CRYPTO_EXTERNAL_CORE)
    include(${TARGET_PLATFORM_PATH}/../external_core.cmake)
else()
    target_include_directories(tfm_api_ns
        PUBLIC
            ${INTERFACE_INC_DIR}
    )
endif()

target_include_directories(tfm_api_ns
    PUBLIC
        ${INTERFACE_INC_DIR}
        ${INTERFACE_INC_DIR}/crypto_keys
)

if (CONFIG_TFM_USE_TRUSTZONE)
    add_library(tfm_api_ns_tz INTERFACE)

    target_sources(tfm_api_ns_tz
        INTERFACE
            ${INTERFACE_SRC_DIR}/tfm_tz_psa_ns_api.c
    )

    target_link_libraries(tfm_api_ns_tz
        INTERFACE
            ${CMAKE_CURRENT_SOURCE_DIR}/interface/lib/s_veneers.o
    )
endif()

if (TFM_PARTITION_NS_AGENT_MAILBOX)
    add_library(tfm_api_ns_mailbox INTERFACE)

    target_sources(tfm_api_ns_mailbox
        INTERFACE
            ${INTERFACE_SRC_DIR}/multi_core/tfm_multi_core_ns_api.c
            ${INTERFACE_SRC_DIR}/multi_core/tfm_multi_core_psa_ns_api.c
    )

    target_include_directories(tfm_api_ns_mailbox
        INTERFACE
            ${INTERFACE_INC_DIR}/multi_core
    )
endif()

if (TFM_PARTITION_CRYPTO)
    target_link_libraries(tfm_api_ns
        PUBLIC
            psa_crypto_config
    )
endif()

add_library(platform_region_defs INTERFACE)

target_compile_definitions(platform_region_defs
    INTERFACE
        $<$<BOOL:${BL1}>:BL1>
        $<$<BOOL:${BL2}>:BL2>
        BL2_HEADER_SIZE=${BL2_HEADER_SIZE}
        BL2_TRAILER_SIZE=${BL2_TRAILER_SIZE}
        BL1_HEADER_SIZE=${BL1_HEADER_SIZE}
        BL1_TRAILER_SIZE=${BL1_TRAILER_SIZE}
        $<$<BOOL:${MCUBOOT_IMAGE_NUMBER}>:MCUBOOT_IMAGE_NUMBER=${MCUBOOT_IMAGE_NUMBER}>
        $<$<BOOL:${TEST_PSA_API}>:PSA_API_TEST_${TEST_PSA_API}>
        $<$<OR:$<CONFIG:Debug>,$<CONFIG:relwithdebinfo>>:ENABLE_HEAP>
)

target_link_libraries(platform_region_defs
    INTERFACE
        tfm_config
)

add_subdirectory(platform)

target_sources(platform_ns
    PRIVATE
        $<$<BOOL:${PLATFORM_DEFAULT_UART_STDOUT}>:${CMAKE_CURRENT_SOURCE_DIR}/platform/ext/common/uart_stdout.c>
)

target_compile_definitions(platform_ns
    PUBLIC
        DOMAIN_NS=1
        $<$<BOOL:${PLATFORM_DEFAULT_CRYPTO_KEYS}>:PLATFORM_DEFAULT_CRYPTO_KEYS>
        $<$<STREQUAL:${CONFIG_TFM_FLOAT_ABI},hard>:CONFIG_TFM_FLOAT_ABI=2>
        $<$<STREQUAL:${CONFIG_TFM_FLOAT_ABI},soft>:CONFIG_TFM_FLOAT_ABI=0>
        $<$<BOOL:${CONFIG_TFM_ENABLE_CP10CP11}>:CONFIG_TFM_ENABLE_CP10CP11>
)

target_link_libraries(tfm_api_ns
    PUBLIC
        platform_region_defs
        platform_ns
)

if(BL2 AND PLATFORM_DEFAULT_IMAGE_SIGNING)

    find_package(Python3)

    add_custom_target(tfm_s_ns_signed_bin
        ALL
        SOURCES ${CMAKE_BINARY_DIR}/tfm_s_ns_signed.bin
    )

    if (MCUBOOT_IMAGE_NUMBER GREATER 1)

        add_custom_target(tfm_ns_signed_bin
            SOURCES ${CMAKE_BINARY_DIR}/bin/tfm_ns_signed.bin
        )
        add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/bin/tfm_ns_signed.bin
            DEPENDS tfm_ns_bin $<TARGET_FILE_DIR:tfm_ns>/tfm_ns.bin
            DEPENDS $<IF:$<BOOL:${MCUBOOT_GENERATE_SIGNING_KEYPAIR}>,generated_private_key,>
            DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_ns.o
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts

            #Sign non-secure binary image with provided secret key
            COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts/wrapper/wrapper.py
                --version ${MCUBOOT_IMAGE_VERSION_NS}
                --layout ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_ns.o
                --key ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/keys/image_ns_signing_private_key.pem
                --public-key-format $<IF:$<BOOL:${MCUBOOT_HW_KEY}>,full,hash>
                --align ${MCUBOOT_ALIGN_VAL}
                --pad
                --pad-header
                -H ${BL2_HEADER_SIZE}
                -s ${MCUBOOT_SECURITY_COUNTER_NS}
                -L ${MCUBOOT_ENC_KEY_LEN}
                -d \"\(0, ${MCUBOOT_S_IMAGE_MIN_VER}\)\"
                $<$<STREQUAL:${MCUBOOT_UPGRADE_STRATEGY},OVERWRITE_ONLY>:--overwrite-only>
                $<$<BOOL:${MCUBOOT_CONFIRM_IMAGE}>:--confirm>
                $<$<BOOL:${MCUBOOT_ENC_IMAGES}>:-E${CMAKE_CURRENT_SOURCE_DIR}/image_signing/keys/image_enc_key.pem>
                $<$<BOOL:${MCUBOOT_MEASURED_BOOT}>:--measured-boot-record>
                $<TARGET_FILE_DIR:tfm_ns>/tfm_ns.bin
                ${CMAKE_BINARY_DIR}/bin/tfm_ns_signed.bin
        )

        # Create concatenated binary image from the two independently signed
        # binary file. This only uses the local assemble.py script (not from
        # upstream mcuboot) because that script is geared towards zephyr
        # support
        add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/tfm_s_ns_signed.bin
            DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/bin/tfm_s_signed.bin
            DEPENDS tfm_ns_signed_bin ${CMAKE_BINARY_DIR}/bin/tfm_ns_signed.bin
            DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_s.o
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts

            COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts/assemble.py
                --layout ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_s.o
                --secure ${CMAKE_CURRENT_SOURCE_DIR}/bin/tfm_s_signed.bin
                --non_secure ${CMAKE_BINARY_DIR}/bin/tfm_ns_signed.bin
                --output ${CMAKE_BINARY_DIR}/tfm_s_ns_signed.bin
        )
    else()
        add_custom_target(tfm_s_ns_bin
            SOURCES ${CMAKE_BINARY_DIR}/bin/tfm_s_ns.bin
        )
        add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/bin/tfm_s_ns.bin
            DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/bin/tfm_s.bin
            DEPENDS tfm_ns_bin $<TARGET_FILE_DIR:tfm_ns>/tfm_ns.bin
            DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_s_ns.o
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts

            # concatenate S + NS binaries into tfm_s_ns.bin
            COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts/assemble.py
                --layout ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_s_ns.o
                --secure ${CMAKE_CURRENT_SOURCE_DIR}/bin/tfm_s.bin
                --non_secure $<TARGET_FILE_DIR:tfm_ns>/tfm_ns.bin
                --output ${CMAKE_BINARY_DIR}/bin/tfm_s_ns.bin
        )

        add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/tfm_s_ns_signed.bin
            DEPENDS tfm_s_ns_bin ${CMAKE_BINARY_DIR}/bin/tfm_s_ns.bin
            DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_s_ns.o
            DEPENDS $<IF:$<BOOL:${MCUBOOT_GENERATE_SIGNING_KEYPAIR}>,generated_private_key,>
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts

            # sign the combined tfm_s_ns.bin file
            COMMAND ${Python3_EXECUTABLE}
                ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/scripts/wrapper/wrapper.py
                --version ${MCUBOOT_IMAGE_VERSION_S}
                --layout ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/layout_files/signing_layout_s_ns.o
                --key ${CMAKE_CURRENT_SOURCE_DIR}/image_signing/keys/image_s_signing_private_key.pem
                --public-key-format $<IF:$<BOOL:${MCUBOOT_HW_KEY}>,full,hash>
                --align ${MCUBOOT_ALIGN_VAL}
                --pad
                --pad-header
                -H ${BL2_HEADER_SIZE}
                -s ${MCUBOOT_SECURITY_COUNTER_S}
                -L ${MCUBOOT_ENC_KEY_LEN}
                $<$<STREQUAL:${MCUBOOT_UPGRADE_STRATEGY},OVERWRITE_ONLY>:--overwrite-only>
                $<$<BOOL:${MCUBOOT_CONFIRM_IMAGE}>:--confirm>
                $<$<BOOL:${MCUBOOT_ENC_IMAGES}>:-E${CMAKE_CURRENT_SOURCE_DIR}/image_signing/keys/image_enc_key.pem>
                $<$<BOOL:${MCUBOOT_MEASURED_BOOT}>:--measured-boot-record>
                ${CMAKE_BINARY_DIR}/bin/tfm_s_ns.bin
                ${CMAKE_BINARY_DIR}/tfm_s_ns_signed.bin
        )
    endif()
endif()
