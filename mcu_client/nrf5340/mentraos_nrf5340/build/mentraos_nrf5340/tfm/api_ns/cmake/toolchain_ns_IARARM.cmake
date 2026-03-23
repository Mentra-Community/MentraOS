#-------------------------------------------------------------------------------
# Copyright (c) 2023-2024, Arm Limited. All rights reserved.
#
# SPDX-License-Identifier: BSD-3-Clause
#
#-------------------------------------------------------------------------------

cmake_minimum_required(VERSION 3.22)
cmake_policy(SET CMP0115 NEW)

SET(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR       ${TFM_SYSTEM_PROCESSOR})

if(CROSS_COMPILE)
    set(CMAKE_C_COMPILER_TARGET      arm-${CROSS_COMPILE})
    set(CMAKE_ASM_COMPILER_TARGET    arm-${CROSS_COMPILE})
else()
    set(CMAKE_C_COMPILER_TARGET      arm-arm-none-eabi)
    set(CMAKE_ASM_COMPILER_TARGET    arm-arm-none-eabi)
endif()

set(CMAKE_C_COMPILER iccarm)
set(CMAKE_CXX_COMPILER iccarm)
set(CMAKE_ASM_COMPILER iasmarm)

set(CMAKE_C_FLAGS_DEBUG "-r -On")

# This variable name is a bit of a misnomer. The file it is set to is included
# at a particular step in the compiler initialisation. It is used here to
# configure the extensions for object files. Despite the name, it also works
# with the Ninja generator.
set(CMAKE_USER_MAKE_RULES_OVERRIDE ${CMAKE_CURRENT_LIST_DIR}/set_extensions.cmake)

macro(tfm_toolchain_reset_compiler_flags)
    set_property(DIRECTORY PROPERTY COMPILE_OPTIONS "")

    add_compile_options(
        $<$<COMPILE_LANGUAGE:C,CXX>:-e>
        $<$<COMPILE_LANGUAGE:C,CXX>:--dlib_config=full>
        $<$<COMPILE_LANGUAGE:C,CXX>:--silent>
        $<$<COMPILE_LANGUAGE:C,CXX>:-DNO_TYPEOF>
        $<$<COMPILE_LANGUAGE:C,CXX>:-D_NO_DEFINITIONS_IN_HEADER_FILES>
        $<$<COMPILE_LANGUAGE:C,CXX>:--diag_suppress=Pe546,Pe940,Pa082,Pa084>
        $<$<COMPILE_LANGUAGE:C,CXX>:--no_path_in_file_macros>
        $<$<AND:$<COMPILE_LANGUAGE:C,CXX,ASM>,$<BOOL:${TFM_DEBUG_SYMBOLS}>,$<CONFIG:Release,MinSizeRel>>:-r>
    )
endmacro()

macro(tfm_toolchain_reset_linker_flags)
    set_property(DIRECTORY PROPERTY LINK_OPTIONS "")

    add_link_options(
      --silent
      --semihosting
      --redirect __write=__write_buffered
      --diag_suppress=lp005
    )
endmacro()

macro(tfm_toolchain_set_processor_arch)
    if(${TFM_SYSTEM_PROCESSOR} STREQUAL "cortex-m0plus")
      set(CMAKE_SYSTEM_PROCESSOR Cortex-M0+)
    else()
      set(CMAKE_SYSTEM_PROCESSOR ${TFM_SYSTEM_PROCESSOR})
    endif()

    if (DEFINED TFM_SYSTEM_DSP)
        if(NOT TFM_SYSTEM_DSP)
            string(APPEND CMAKE_SYSTEM_PROCESSOR ".no_dsp")
        endif()
    endif()
endmacro()

macro(tfm_toolchain_reload_compiler)
    tfm_toolchain_set_processor_arch()
    tfm_toolchain_reset_compiler_flags()
    tfm_toolchain_reset_linker_flags()

    unset(CMAKE_C_FLAGS_INIT)
    unset(CMAKE_C_LINK_FLAGS)
    unset(CMAKE_ASM_FLAGS_INIT)
    unset(CMAKE_ASM_LINK_FLAGS)

    set(CMAKE_C_FLAGS_INIT "--cpu ${CMAKE_SYSTEM_PROCESSOR}")
    set(CMAKE_ASM_FLAGS_INIT "--cpu ${CMAKE_SYSTEM_PROCESSOR}")
    set(CMAKE_C_LINK_FLAGS "--cpu ${CMAKE_SYSTEM_PROCESSOR}")
    set(CMAKE_ASM_LINK_FLAGS "--cpu ${CMAKE_SYSTEM_PROCESSOR}")

    set(CMAKE_C_FLAGS ${CMAKE_C_FLAGS_INIT})
    set(CMAKE_ASM_FLAGS ${CMAKE_ASM_FLAGS_INIT})

    # Can't use the highest optimization with IAR on v8.1m arch because of the
    # compilation bug in mbedcrypto
    if ((CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "9.20") AND
        (CMAKE_C_COMPILER_VERSION VERSION_LESS_EQUAL "9.32.1") AND
        ((TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m85") OR
         (TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m55")) AND
        (NOT (CMAKE_BUILD_TYPE STREQUAL "Debug")))
        message(FATAL_ERROR "Only debug build available for M55 and M85"
                " cores with IAR version between 9.20 and 9.32.1")
    endif()

    if (CONFIG_TFM_FLOAT_ABI STREQUAL "hard")
        if (CONFIG_TFM_ENABLE_FP)
            set(COMPILER_CP_C_FLAG "--fpu=${CONFIG_TFM_FP_ARCH_ASM}")
            set(COMPILER_CP_ASM_FLAG "--fpu=${CONFIG_TFM_FP_ARCH_ASM}")
            # armasm and armlink have the same option "--fpu" and are both used to
            # specify the target FPU architecture. So the supported FPU architecture
            # names can be shared by armasm and armlink.
            set(LINKER_CP_OPTION "--fpu=${CONFIG_TFM_FP_ARCH_ASM}")
        endif()
    else()
        set(COMPILER_CP_C_FLAG   "--fpu=none")
        set(COMPILER_CP_ASM_FLAG "--fpu=none")
        set(LINKER_CP_OPTION     "--fpu=none")
    endif()

    string(APPEND CMAKE_C_FLAGS " " ${COMPILER_CP_C_FLAG})
    string(APPEND CMAKE_ASM_FLAGS " " ${COMPILER_CP_ASM_FLAG})
    string(APPEND CMAKE_C_LINK_FLAGS " " ${LINKER_CP_OPTION})
    string(APPEND CMAKE_ASM_LINK_FLAGS " " ${LINKER_CP_OPTION})

    add_compile_definitions(
        $<$<STREQUAL:${TFM_SYSTEM_ARCHITECTURE},armv6-m>:__ARM_ARCH_6M__=1>
        $<$<STREQUAL:${TFM_SYSTEM_ARCHITECTURE},armv7-m>:__ARM_ARCH_7M__=1>
        $<$<AND:$<STREQUAL:${TFM_SYSTEM_ARCHITECTURE},armv7-m>,$<BOOL:__ARM_FEATURE_DSP>>:__ARM_ARCH_7EM__=1>
        $<$<STREQUAL:${TFM_SYSTEM_ARCHITECTURE},armv8-m.base>:__ARM_ARCH_8M_BASE__=1>
        $<$<STREQUAL:${TFM_SYSTEM_ARCHITECTURE},armv8-m.main>:__ARM_ARCH_8M_MAIN__=1>
        $<$<STREQUAL:${TFM_SYSTEM_ARCHITECTURE},armv8.1-m.main>:__ARM_ARCH_8_1M_MAIN__=1>
    )
endmacro()

# Configure environment for the compiler setup run by cmake at the first
# `project` call in <tfm_root>/CMakeLists.txt. After this mandatory setup is
# done, all further compiler setup is done via tfm_toolchain_reload_compiler()
tfm_toolchain_reload_compiler()

# Specify the scatter file used to link `target`.
# Behaviour for handling scatter files is so wildly divergent between compilers
# that this macro is required.
#
# Vendor platform can set a scatter file as property INTERFACE_LINK_DEPENDS of platform_ns.
# `target` can fetch the scatter file from platform_ns.
#
# Alternatively, NS build can call target_add_scatter_file() with the install directory of
# scatter files.
#     target_add_scatter_file(target, install_dir)
#
# target_add_scatter_file() fetch a scatter file from the install directory.
macro(target_add_scatter_file target)
    # Try if scatter_file is passed from platform_ns
    get_target_property(scatter_file
                        platform_ns
                        INTERFACE_LINK_DEPENDS
    )

    # If scatter_file is not passed from platform_ns
    # Try if any scatter file is exported in install directory
    # The intall directory is passed as an optinal argument
    if(${scatter_file} STREQUAL "scatter_file-NOTFOUND")
        set(install_dir ${ARGN})
        list(LENGTH install_dir nr_install_dir)

        # If nr_install_dir == 1, search for .icf file under install dir
        if(${nr_install_dir} EQUAL 1)
            file(GLOB scatter_file "${install_dir}/*.icf")
        endif()
    endif()

    if(NOT EXISTS ${scatter_file})
        message(FATAL_ERROR "Unable to find NS scatter file ${scatter_file}")
    endif()

    add_library(${target}_scatter OBJECT)
    target_sources(${target}_scatter
        PRIVATE
            ${scatter_file}
    )
    # Cmake cannot use generator expressions in the
    # set_source_file_properties command, so instead we just parse the regex
    # for the filename and set the property on all files, regardless of if
    # the generator expression would evaluate to true or not.
    string(REGEX REPLACE ".*>:(.*)>$" "\\1" SCATTER_FILE_PATH "${scatter_file}")
    set_source_files_properties(${SCATTER_FILE_PATH}
        PROPERTIES
        LANGUAGE C
    )

    target_link_options(${target}
        PRIVATE
            --config $<TARGET_OBJECTS:${target}_scatter>
    )

    add_dependencies(${target}
        ${target}_scatter
    )

    set_target_properties(${target} PROPERTIES LINK_DEPENDS $<TARGET_OBJECTS:${target}_scatter>)

    target_link_libraries(${target}_scatter
        PRIVATE
            platform_region_defs
    )

    target_compile_options(${target}_scatter
        PRIVATE
            --preprocess=sn $<TARGET_OBJECTS:${target}_scatter>
    )
endmacro()

macro(add_convert_to_bin_target target)
    get_target_property(bin_dir ${target} RUNTIME_OUTPUT_DIRECTORY)

    add_custom_target(${target}_bin
        SOURCES ${bin_dir}/${target}.bin
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.bin
        DEPENDS ${target}
        COMMAND ielftool
            --silent
            --bin $<TARGET_FILE:${target}>
            ${bin_dir}/${target}.bin
    )

    add_custom_target(${target}_elf
        SOURCES ${bin_dir}/${target}.elf
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.elf
        DEPENDS ${target}
        COMMAND ielftool
            --silent
            $<TARGET_FILE:${target}>
            ${bin_dir}/${target}.elf
    )

    add_custom_target(${target}_hex
        SOURCES ${bin_dir}/${target}.hex
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.hex
        DEPENDS ${target}
        COMMAND ielftool
            --silent
            --ihex $<TARGET_FILE:${target}>
            ${bin_dir}/${target}.hex
    )

    add_custom_target(${target}_binaries
        ALL
        DEPENDS ${target}_bin
        DEPENDS ${target}_elf
        DEPENDS ${target}_hex
    )
endmacro()
