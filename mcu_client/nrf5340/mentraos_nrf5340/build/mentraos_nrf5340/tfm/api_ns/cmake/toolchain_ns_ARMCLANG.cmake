#-------------------------------------------------------------------------------
# Copyright (c) 2023, Arm Limited. All rights reserved.
#
# SPDX-License-Identifier: BSD-3-Clause
#
#-------------------------------------------------------------------------------
cmake_minimum_required(VERSION 3.21)

SET(CMAKE_SYSTEM_NAME Generic)

set(CMAKE_C_COMPILER_FORCED TRUE)
set(CMAKE_CXX_COMPILER_FORCED TRUE)

if(NOT DEFINED CROSS_COMPILE)
    set(CROSS_COMPILE    arm-none-eabi CACHE STRING "Cross-compiler prefix")
endif()

set(CMAKE_C_COMPILER armclang)
set(CMAKE_CXX_COMPILER armclang)
set(CMAKE_ASM_COMPILER armasm)

# This variable name is a bit of a misnomer. The file it is set to is included
# at a particular step in the compiler initialisation. It is used here to
# configure the extensions for object files. Despite the name, it also works
# with the Ninja generator.
set(CMAKE_USER_MAKE_RULES_OVERRIDE ${CMAKE_CURRENT_LIST_DIR}/set_extensions.cmake)

if(NOT DEFINED CMAKE_OBJCOPY)
    set(CMAKE_OBJCOPY ${CROSS_COMPILE}-objcopy CACHE FILEPATH "Path to objcopy")
endif()

# Set compiler ID explicitly as it's not detected at this moment
set(CMAKE_C_COMPILER_ID ARMClang)

macro(tfm_toolchain_reset_compiler_flags)
    set_property(DIRECTORY PROPERTY COMPILE_OPTIONS "")

    add_compile_options(
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-Wno-ignored-optimization-argument>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-Wno-unused-command-line-argument>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-Wall>
        # Don't error when the MBEDTLS_NULL_ENTROPY warning is shown
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-Wno-error=cpp>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-c>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-fdata-sections>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-ffunction-sections>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-fno-builtin>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-fshort-enums>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-fshort-wchar>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-funsigned-char>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-masm=auto>
        $<$<OR:$<COMPILE_LANGUAGE:C>,$<COMPILE_LANGUAGE:CXX>>:-nostdlib>
        $<$<COMPILE_LANGUAGE:C>:-std=c99>
        $<$<COMPILE_LANGUAGE:CXX>:-std=c++11>
        $<$<COMPILE_LANGUAGE:ASM>:--cpu=${CMAKE_ASM_CPU_FLAG}>
        $<$<AND:$<COMPILE_LANGUAGE:C>,$<BOOL:${TFM_DEBUG_SYMBOLS}>>:-g>
        $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<BOOL:${TFM_DEBUG_SYMBOLS}>>:-g>
    )
endmacro()

set(MEMORY_USAGE_FLAG --info=summarysizes,sizes,totals,unused,veneers)

macro(tfm_toolchain_reset_linker_flags)
    set_property(DIRECTORY PROPERTY LINK_OPTIONS "")

    add_link_options(
        ${MEMORY_USAGE_FLAG}
        --strict
        --symbols
        --xref
        $<$<AND:$<VERSION_GREATER:${TFM_ISOLATION_LEVEL},1>,$<STREQUAL:"${TEST_PSA_API}","IPC">>:--no-merge>
        # Suppress link warnings that are consistant (and therefore hopefully
        # harmless)
        # https://developer.arm.com/documentation/100074/0608/linker-errors-and-warnings/list-of-the-armlink-error-and-warning-messages
        # Empty region description
        --diag_suppress=6312
        # Ns section matches pattern
        --diag_suppress=6314
        # Duplicate input files
        --diag_suppress=6304
        # Pattern only matches removed unused sections.
        --diag_suppress=6329
    )
endmacro()

macro(tfm_toolchain_set_processor_arch)
    if (DEFINED TFM_SYSTEM_PROCESSOR)
        set(CMAKE_SYSTEM_PROCESSOR       ${TFM_SYSTEM_PROCESSOR})

        if (TFM_SYSTEM_ARCHITECTURE STREQUAL "armv8.1-m.main")
            message(WARNING "MVE is not yet supported using ARMCLANG")
            string(APPEND CMAKE_SYSTEM_PROCESSOR "+nomve")
        endif()

        if (DEFINED TFM_SYSTEM_DSP)
            if(NOT TFM_SYSTEM_DSP)
                string(APPEND CMAKE_SYSTEM_PROCESSOR "+nodsp")
            endif()
        endif()

        # ARMCLANG specifies that '+nofp' is available on following M-profile cpus:
        # 'cortex-m4', 'cortex-m7', 'cortex-m33', 'cortex-m35p', 'cortex-m55' and 'cortex-m85'.
        # Build fails if other M-profile cpu, such as 'cortex-m23', is added with '+nofp'.
        # Explicitly list those cpu to align with ARMCLANG description.
        if (NOT CONFIG_TFM_FLOAT_ABI STREQUAL "hard" AND
            (TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m4"
            OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m7"
            OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m33"
            OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m35p"
            OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m55"
            OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m85"))
                string(APPEND CMAKE_SYSTEM_PROCESSOR "+nofp")
        endif()

        string(REGEX REPLACE "\\+nodsp" ".no_dsp" CMAKE_ASM_CPU_FLAG "${CMAKE_SYSTEM_PROCESSOR}")
        string(REGEX REPLACE "\\+nomve" ".no_mve" CMAKE_ASM_CPU_FLAG "${CMAKE_ASM_CPU_FLAG}")
        string(REGEX REPLACE "\\+nofp" ".no_fp" CMAKE_ASM_CPU_FLAG "${CMAKE_ASM_CPU_FLAG}")
    else()
        set(CMAKE_ASM_CPU_FLAG  ${TFM_SYSTEM_ARCHITECTURE})

        # Armasm uses different syntax than armclang for architecture targets
        string(REGEX REPLACE "\\armv" "" CMAKE_ASM_CPU_FLAG "${CMAKE_ASM_CPU_FLAG}")
        string(REGEX REPLACE "\\armv" "" CMAKE_ASM_CPU_FLAG "${CMAKE_ASM_CPU_FLAG}")

        # Modifiers are additive instead of subtractive (.fp Vs .no_fp)
        if (TFM_SYSTEM_DSP)
            string(APPEND CMAKE_ASM_CPU_FLAG ".dsp")
        endif()

        if (CONFIG_TFM_FLOAT_ABI STREQUAL "hard")
            string(APPEND CMAKE_ASM_CPU_FLAG ".fp")
        endif()
    endif()

    # CMAKE_SYSTEM_ARCH is an ARMCLANG CMAKE internal variable, used to set
    # compile and linker flags up until CMake 3.21 where CMP0123 was introduced:
    # https://cmake.org/cmake/help/latest/policy/CMP0123.html
    # This behavior is overwritten by setting CMAKE_C_FLAGS in
    # tfm_toolchain_reload_compiler.
    # Another use of this variable is to statisfy a requirement for ARMCLANG to
    # set either the target CPU or the Architecture. This variable needs to be
    # set to allow targeting architectures without a specific CPU.
    set(CMAKE_SYSTEM_ARCH            ${TFM_SYSTEM_ARCHITECTURE})

    set(CMAKE_C_COMPILER_TARGET      arm-${CROSS_COMPILE})
    set(CMAKE_CXX_COMPILER_TARGET    arm-${CROSS_COMPILE})
    set(CMAKE_ASM_COMPILER_TARGET    arm-${CROSS_COMPILE})

    # MVE is currently not supported in case of armclang
    if (TFM_SYSTEM_ARCHITECTURE STREQUAL "armv8.1-m.main")
        string(APPEND CMAKE_SYSTEM_ARCH "+nomve")
    endif()

    if (DEFINED TFM_SYSTEM_DSP)
        if(NOT TFM_SYSTEM_DSP)
            string(APPEND CMAKE_SYSTEM_ARCH "+nodsp")
        endif()
    endif()

    # Cmake's ARMClang support has several issues with compiler validation. To
    # avoid these, we set the list of supported -mcpu and -march variables to
    # the ones we intend to use so that the validation will never fail.
    include(Compiler/ARMClang)
    set(CMAKE_C_COMPILER_PROCESSOR_LIST ${CMAKE_SYSTEM_PROCESSOR})
    set(CMAKE_C_COMPILER_ARCH_LIST ${CMAKE_SYSTEM_ARCH})
    set(CMAKE_CXX_COMPILER_PROCESSOR_LIST ${CMAKE_SYSTEM_PROCESSOR})
    set(CMAKE_CXX_COMPILER_ARCH_LIST ${CMAKE_SYSTEM_ARCH})
    set(CMAKE_ASM_COMPILER_PROCESSOR_LIST ${CMAKE_SYSTEM_PROCESSOR})
    set(CMAKE_ASM_COMPILER_ARCH_LIST ${CMAKE_SYSTEM_ARCH})
endmacro()

macro(tfm_toolchain_reload_compiler)
    tfm_toolchain_set_processor_arch()
    tfm_toolchain_reset_compiler_flags()
    tfm_toolchain_reset_linker_flags()

    unset(CMAKE_C_FLAGS_INIT)
    unset(CMAKE_CXX_FLAGS_INIT)
    unset(CMAKE_C_LINK_FLAGS)
    unset(CMAKE_ASM_FLAGS_INIT)
    unset(CMAKE_ASM_LINK_FLAGS)
    unset(__mcpu_flag_set)
    unset(__march_flag_set)

    include(Compiler/ARMClang)
    __compiler_armclang(C)
    include(Compiler/ARMCC-ASM)
    __compiler_armcc(ASM)

    if (CMAKE_C_COMPILER_VERSION VERSION_LESS 6.13)
        message(FATAL_ERROR "Please select newer Arm compiler version starting from 6.13.")
    endif()

    if (CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL 6.15 AND
        CMAKE_C_COMPILER_VERSION VERSION_LESS 6.18)
        message(FATAL_ERROR "Armclang 6.15~6.17 may cause MemManage fault."
                            " This defect has been fixed since Armclang 6.18."
                            " See [SDCOMP-59788] in Armclang 6.18 release note for details."
                            " Please use other Armclang versions instead.")
    endif()

    set(CMAKE_ASM_FLAGS ${CMAKE_ASM_FLAGS_INIT})

    if (DEFINED TFM_SYSTEM_PROCESSOR)
        set(CMAKE_C_FLAGS "-mcpu=${CMAKE_SYSTEM_PROCESSOR}")
        set(CMAKE_CXX_FLAGS "-mcpu=${CMAKE_SYSTEM_PROCESSOR}")
        set(CMAKE_C_LINK_FLAGS   "--cpu=${CMAKE_SYSTEM_PROCESSOR}")
        set(CMAKE_CXX_LINK_FLAGS "--cpu=${CMAKE_SYSTEM_PROCESSOR}")
        set(CMAKE_ASM_LINK_FLAGS "--cpu=${CMAKE_SYSTEM_PROCESSOR}")
        # But armlink doesn't support this +dsp syntax
        string(REGEX REPLACE "\\+nodsp" "" CMAKE_C_LINK_FLAGS   "${CMAKE_C_LINK_FLAGS}")
        string(REGEX REPLACE "\\+nodsp" "" CMAKE_CXX_LINK_FLAGS "${CMAKE_CXX_LINK_FLAGS}")
        string(REGEX REPLACE "\\+nodsp" "" CMAKE_ASM_LINK_FLAGS "${CMAKE_ASM_LINK_FLAGS}")
        # And uses different syntax for +nofp
        string(REGEX REPLACE "\\+nofp" ".no_fp" CMAKE_C_LINK_FLAGS   "${CMAKE_C_LINK_FLAGS}")
        string(REGEX REPLACE "\\+nofp" ".no_fp" CMAKE_CXX_LINK_FLAGS "${CMAKE_CXX_LINK_FLAGS}")
        string(REGEX REPLACE "\\+nofp" ".no_fp" CMAKE_ASM_LINK_FLAGS "${CMAKE_ASM_LINK_FLAGS}")

        string(REGEX REPLACE "\\+nomve" ".no_mve" CMAKE_C_LINK_FLAGS   "${CMAKE_C_LINK_FLAGS}")
        string(REGEX REPLACE "\\+nomve" ".no_mve" CMAKE_CXX_LINK_FLAGS "${CMAKE_CXX_LINK_FLAGS}")
        string(REGEX REPLACE "\\+nomve" ".no_mve" CMAKE_ASM_LINK_FLAGS "${CMAKE_ASM_LINK_FLAGS}")
    else()
        set(CMAKE_C_FLAGS "-march=${CMAKE_SYSTEM_ARCH}")
        set(CMAKE_CXX_FLAGS "-march=${CMAKE_SYSTEM_ARCH}")
    endif()

    # This flag is used to check if toolchain has fixed VLLDM vulnerability
    # Check command will fail if C flags consist of keyword other than cpu/arch type.
    set(CP_CHECK_C_FLAGS ${CMAKE_C_FLAGS})

    if (CONFIG_TFM_FLOAT_ABI STREQUAL "hard")
        set(COMPILER_CP_C_FLAG "-mfloat-abi=hard")
        if (CONFIG_TFM_ENABLE_FP)
            set(COMPILER_CP_C_FLAG "-mfloat-abi=hard -mfpu=${CONFIG_TFM_FP_ARCH}")
            set(COMPILER_CP_ASM_FLAG "--fpu=${CONFIG_TFM_FP_ARCH_ASM}")
            # armasm and armlink have the same option "--fpu" and are both used to
            # specify the target FPU architecture. So the supported FPU architecture
            # names can be shared by armasm and armlink.
            set(LINKER_CP_OPTION "--fpu=${CONFIG_TFM_FP_ARCH_ASM}")
        endif()
    else()
        set(COMPILER_CP_C_FLAG   "-mfpu=softvfp")
        set(COMPILER_CP_ASM_FLAG "--fpu=softvfp")
        set(LINKER_CP_OPTION     "--fpu=SoftVFP")
    endif()

    string(APPEND CMAKE_C_FLAGS " " ${COMPILER_CP_C_FLAG})
    string(APPEND CMAKE_ASM_FLAGS " " ${COMPILER_CP_ASM_FLAG})
    string(APPEND CMAKE_C_LINK_FLAGS " " ${LINKER_CP_OPTION})
    string(APPEND CMAKE_ASM_LINK_FLAGS " " ${LINKER_CP_OPTION})

    # Workaround for issues with --depend-single-line with armasm and Ninja
    if (CMAKE_GENERATOR STREQUAL "Ninja")
        set( CMAKE_DEPFILE_FLAGS_ASM "--depend=<OBJECT>.d")
    endif()

    set(CMAKE_C_FLAGS_MINSIZEREL "-Oz -DNDEBUG")
endmacro()

# Configure environment for the compiler setup run by cmake at the first
# `project` call in <tfm_root>/CMakeLists.txt. After this mandatory setup is
# done, all further compiler setup is done via tfm_toolchain_reload_compiler()
tfm_toolchain_set_processor_arch()
tfm_toolchain_reset_compiler_flags()
tfm_toolchain_reset_linker_flags()

macro(add_convert_to_bin_target target)
    get_target_property(bin_dir ${target} RUNTIME_OUTPUT_DIRECTORY)

    add_custom_target(${target}_bin
        SOURCES ${bin_dir}/${target}.bin
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.bin
        DEPENDS ${target}
        COMMAND fromelf
            --bincombined $<TARGET_FILE:${target}>
            --output=${bin_dir}/${target}.bin
    )

    add_custom_target(${target}_elf
        SOURCES ${bin_dir}/${target}.elf
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.elf
        DEPENDS ${target}
        COMMAND fromelf
            --elf $<TARGET_FILE:${target}>
            --output=${bin_dir}/${target}.elf
    )

    add_custom_target(${target}_hex
        SOURCES ${bin_dir}/${target}.hex
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.hex
        DEPENDS ${target}
        COMMAND fromelf
            --i32combined $<TARGET_FILE:${target}>
            --output=${bin_dir}/${target}.hex
    )

    add_custom_target(${target}_binaries
        ALL
        DEPENDS ${target}_bin
        DEPENDS ${target}_elf
        DEPENDS ${target}_hex
    )
endmacro()

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

        # If nr_install_dir == 1, search for sct file under install dir
        if(${nr_install_dir} EQUAL 1)
            file(GLOB scatter_file "${install_dir}/*.sct")
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
            --scatter=$<TARGET_OBJECTS:${target}_scatter>
    )

    target_link_libraries(${target}_scatter
        PRIVATE
            platform_region_defs
    )

    target_compile_options(${target}_scatter
        PRIVATE
            -E
            -xc
    )

    add_dependencies(${target} ${target}_scatter)
    set_target_properties(${target} PROPERTIES LINK_DEPENDS $<TARGET_OBJECTS:${target}_scatter>)

endmacro()
