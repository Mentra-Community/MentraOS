#-------------------------------------------------------------------------------
# Copyright (c) 2020-2024, Arm Limited. All rights reserved.
#
# SPDX-License-Identifier: BSD-3-Clause
#
#-------------------------------------------------------------------------------

set(CMAKE_SYSTEM_NAME Generic)

set(CMAKE_C_COMPILER_FORCED TRUE)
set(CMAKE_CXX_COMPILER_FORCED TRUE)

if(NOT DEFINED CROSS_COMPILE)
    set(CROSS_COMPILE    arm-none-eabi CACHE STRING "Cross-compiler prefix")
endif()

find_program(CMAKE_C_COMPILER ${CROSS_COMPILE}-gcc)
find_program(CMAKE_CXX_COMPILER ${CROSS_COMPILE}-g++)

if(CMAKE_C_COMPILER STREQUAL "CMAKE_C_COMPILER-NOTFOUND")
    message(FATAL_ERROR "Could not find compiler: '${CROSS_COMPILE}-gcc'")
endif()

if(CMAKE_CXX_COMPILER STREQUAL "CMAKE_CXX_COMPILER-NOTFOUND")
    message(FATAL_ERROR "Could not find compiler: '${CROSS_COMPILE}-g++'")
endif()

set(CMAKE_ASM_COMPILER ${CMAKE_C_COMPILER})

# Set compiler ID explicitly as it's not detected at this moment
set(CMAKE_C_COMPILER_ID GNU)

# This variable name is a bit of a misnomer. The file it is set to is included
# at a particular step in the compiler initialisation. It is used here to
# configure the extensions for object files. Despite the name, it also works
# with the Ninja generator.
set(CMAKE_USER_MAKE_RULES_OVERRIDE ${CMAKE_CURRENT_LIST_DIR}/set_extensions.cmake)

# CMAKE_C_COMPILER_VERSION is not guaranteed to be defined.
EXECUTE_PROCESS( COMMAND ${CMAKE_C_COMPILER} -dumpversion OUTPUT_VARIABLE GCC_VERSION )

# ===================== Set toolchain CPU and Arch =============================

if (DEFINED TFM_SYSTEM_PROCESSOR)
    if(TFM_SYSTEM_PROCESSOR MATCHES "cortex-m85" AND GCC_VERSION VERSION_LESS "13.0.0")
        # GNUARM until version 13 does not support the -mcpu=cortex-m85 flag
        message(WARNING "Cortex-m85 is only supported from GCC13. "
                        "Falling back to -march usage for earlier versions.")
    else()
        set(CMAKE_SYSTEM_PROCESSOR ${TFM_SYSTEM_PROCESSOR})

        if (DEFINED TFM_SYSTEM_DSP)
            if (NOT TFM_SYSTEM_DSP)
                string(APPEND CMAKE_SYSTEM_PROCESSOR "+nodsp")
            endif()
        endif()
        # GCC specifies that '+nofp' is available on following M-profile cpus: 'cortex-m4',
        # 'cortex-m7', 'cortex-m33', 'cortex-m35p' and 'cortex-m55'.
        # Build fails if other M-profile cpu, such as 'cortex-m23', is added with '+nofp'.
        # Explicitly list those cpu to align with GCC description.
        if(GCC_VERSION VERSION_GREATER_EQUAL "8.0.0")
            if(NOT CONFIG_TFM_ENABLE_FP AND
                (TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m4"
                OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m7"
                OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m33"
                OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m35p"
                OR TFM_SYSTEM_PROCESSOR STREQUAL "cortex-m55"))
                    string(APPEND CMAKE_SYSTEM_PROCESSOR "+nofp")
            endif()
        endif()

        if(TFM_SYSTEM_ARCHITECTURE STREQUAL "armv8.1-m.main")
            if(NOT CONFIG_TFM_ENABLE_MVE)
                string(APPEND CMAKE_SYSTEM_PROCESSOR "+nomve")
            endif()
            if(NOT CONFIG_TFM_ENABLE_MVE_FP)
                string(APPEND CMAKE_SYSTEM_PROCESSOR "+nomve.fp")
            endif()
        endif()
    endif()

endif()

# CMAKE_SYSTEM_ARCH variable is not a built-in CMAKE variable. It is used to
# set the compile and link flags when TFM_SYSTEM_PROCESSOR is not specified.
# The variable name is choosen to align with the ARMCLANG toolchain file.
set(CMAKE_SYSTEM_ARCH         ${TFM_SYSTEM_ARCHITECTURE})

if(TFM_SYSTEM_ARCHITECTURE STREQUAL "armv8.1-m.main")
    if(CONFIG_TFM_ENABLE_MVE)
        string(APPEND CMAKE_SYSTEM_ARCH "+mve")
    endif()
    if(CONFIG_TFM_ENABLE_MVE_FP)
        string(APPEND CMAKE_SYSTEM_ARCH "+mve.fp")
    endif()
endif()

if (DEFINED TFM_SYSTEM_DSP)
    # +nodsp modifier is only supported from GCC version 8.
    if(GCC_VERSION VERSION_GREATER_EQUAL "8.0.0")
        # armv8.1-m.main arch does not have +nodsp option
        if ((NOT TFM_SYSTEM_ARCHITECTURE STREQUAL "armv8.1-m.main") AND
            NOT TFM_SYSTEM_DSP)
            string(APPEND CMAKE_SYSTEM_ARCH "+nodsp")
        endif()
    endif()
endif()

if(GCC_VERSION VERSION_GREATER_EQUAL "8.0.0")
    if(CONFIG_TFM_ENABLE_FP)
        string(APPEND CMAKE_SYSTEM_ARCH "+fp")
    endif()
endif()

if (GCC_VERSION VERSION_LESS 7.3.1)
    message(FATAL_ERROR "Please use newer GNU Arm compiler version starting from 7.3.1.")
endif()

if (GCC_VERSION VERSION_EQUAL 10.2.1)
    message(FATAL_ERROR "GNU Arm compiler version 10-2020-q4-major has an issue in CMSE support."
                        " Select other GNU Arm compiler versions instead."
                        " See https://gcc.gnu.org/bugzilla/show_bug.cgi?id=99157 for the issue detail.")
endif()

# GNU Arm compiler version greater equal than *11.3.Rel1*
# has a linker issue that required system calls are missing,
# such as _read and _write. Add stub functions of required
# system calls to solve this issue.
if (GCC_VERSION VERSION_GREATER_EQUAL 11.3.1)
    set(CONFIG_GNU_SYSCALL_STUB_ENABLED TRUE)
endif()

if (CMAKE_SYSTEM_PROCESSOR)
    set(CMAKE_C_FLAGS_INIT "-mcpu=${CMAKE_SYSTEM_PROCESSOR}")
    set(CMAKE_CXX_FLAGS_INIT "-mcpu=${CMAKE_SYSTEM_PROCESSOR}")
    set(CMAKE_ASM_FLAGS_INIT "-mcpu=${CMAKE_SYSTEM_PROCESSOR}")
    set(CMAKE_C_LINK_FLAGS "-mcpu=${CMAKE_SYSTEM_PROCESSOR}")
    set(CMAKE_ASM_LINK_FLAGS "-mcpu=${CMAKE_SYSTEM_PROCESSOR}")
else()
    set(CMAKE_C_FLAGS_INIT "-march=${CMAKE_SYSTEM_ARCH}")
    set(CMAKE_CXX_FLAGS_INIT "-march=${CMAKE_SYSTEM_ARCH}")
    set(CMAKE_ASM_FLAGS_INIT "-march=${CMAKE_SYSTEM_ARCH}")
    set(CMAKE_C_LINK_FLAGS "-march=${CMAKE_SYSTEM_ARCH}")
    set(CMAKE_ASM_LINK_FLAGS "-march=${CMAKE_SYSTEM_ARCH}")
endif()

set(CMAKE_C_FLAGS ${CMAKE_C_FLAGS_INIT})
set(CMAKE_CXX_FLAGS ${CMAKE_CXX_FLAGS_INIT})
set(CMAKE_ASM_FLAGS ${CMAKE_ASM_FLAGS_INIT})

set(COMPILER_CP_FLAG "-mfloat-abi=soft")
set(LINKER_CP_OPTION "-mfloat-abi=soft")

if(CONFIG_TFM_FLOAT_ABI STREQUAL "hard")
    set(COMPILER_CP_FLAG "-mfloat-abi=hard")
    set(LINKER_CP_OPTION "-mfloat-abi=hard")
    if(CONFIG_TFM_ENABLE_FP OR CONFIG_TFM_ENABLE_MVE_FP)
        string(APPEND COMPILER_CP_FLAG " " "-mfpu=${CONFIG_TFM_FP_ARCH}")
        string(APPEND LINKER_CP_OPTION " " "-mfpu=${CONFIG_TFM_FP_ARCH}")
    endif()
endif()

string(APPEND CMAKE_C_FLAGS " " ${COMPILER_CP_FLAG})
string(APPEND CMAKE_ASM_FLAGS " " ${COMPILER_CP_FLAG})
string(APPEND CMAKE_C_LINK_FLAGS " " ${LINKER_CP_OPTION})
string(APPEND CMAKE_ASM_LINK_FLAGS " " ${LINKER_CP_OPTION})

# For GNU Arm Embedded Toolchain doesn't emit __ARM_ARCH_8_1M_MAIN__, adding this macro manually.
add_compile_definitions($<$<STREQUAL:${TFM_SYSTEM_ARCHITECTURE},armv8.1-m.main>:__ARM_ARCH_8_1M_MAIN__=1>)

# GNU Arm compiler version greater equal than *11.3.Rel1*
# has a linker issue that required system calls are missing,
# such as _read and _write. Add stub functions of required
# system calls to solve this issue.
#
# READONLY linker script attribute is not supported in older
# GNU Arm compilers. For these version the preprocessor will
# remove the READONLY string from the linker scripts.
if (GCC_VERSION VERSION_GREATER_EQUAL 11.3.1)
    set(CONFIG_GNU_SYSCALL_STUB_ENABLED TRUE)
    set(CONFIG_GNU_LINKER_READONLY_ATTRIBUTE TRUE)
endif()

add_compile_options(
    -specs=nano.specs
    -specs=nosys.specs
    -Wall
    -Wno-format
    -Wno-return-type
    -Wno-unused-but-set-variable
    -c
    -fdata-sections
    -ffunction-sections
    -fno-builtin
    -fshort-enums
    -funsigned-char
    -mthumb
    $<$<COMPILE_LANGUAGE:C>:-std=c99>
    $<$<COMPILE_LANGUAGE:CXX>:-std=c++11>
    $<$<AND:$<COMPILE_LANGUAGE:C>,$<BOOL:${TFM_DEBUG_SYMBOLS}>>:-g>
    $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<BOOL:${TFM_DEBUG_SYMBOLS}>>:-g>
)

add_link_options(
    --entry=Reset_Handler
    -specs=nano.specs
    -specs=nosys.specs
    LINKER:-check-sections
    LINKER:-fatal-warnings
    LINKER:--gc-sections
    LINKER:--no-wchar-size-warning
    LINKER:--print-memory-usage
    LINKER:-Map=tfm_ns.map
)

# Specify the linker script used to link `target`.
# Behaviour for handling linker scripts is so wildly divergent between compilers
# that this macro is required.
#
# Vendor platform can set a linker script as property INTERFACE_LINK_DEPENDS of platform_ns.
# `target` can fetch the linker script from platform_ns.
#
# Alternatively, NS build can call target_add_scatter_file() with the install directory of
# linker script.
#     target_add_scatter_file(target, install_dir)
#
# target_add_scatter_file() fetch a linker script from the install directory.
macro(target_add_scatter_file target)

    get_target_property(scatter_file
                        platform_ns
                        INTERFACE_LINK_DEPENDS
    )

    # If scatter_file is not passed from platform_ns
    # Try if any linker script is exported in install directory
    # The intall directory is passed as an optinal argument
    if(${scatter_file} STREQUAL "scatter_file-NOTFOUND")
        set(install_dir ${ARGN})
        list(LENGTH install_dir nr_install_dir)

        # If nr_install_dir == 1, search for sct file under install dir
        if(${nr_install_dir} EQUAL 1)
            file(GLOB scatter_file "${install_dir}/*.ld")
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

    set_source_files_properties(${scatter_file} PROPERTIES
        LANGUAGE C
        KEEP_EXTENSION True)

    target_compile_options(${target}_scatter
        PRIVATE
            -E
            -P
            -xc
    )

    target_compile_definitions(${target}_scatter
        PRIVATE
            $<$<NOT:$<BOOL:${CONFIG_GNU_LINKER_READONLY_ATTRIBUTE}>>:READONLY=>
    )

    target_link_libraries(${target}_scatter
        PRIVATE
            platform_region_defs
    )

    add_dependencies(${target} ${target}_scatter)

    target_link_options(${target}
        PRIVATE
            -T $<TARGET_OBJECTS:${target}_scatter>
    )

endmacro()

macro(add_convert_to_bin_target target)
    get_target_property(bin_dir ${target} RUNTIME_OUTPUT_DIRECTORY)

    add_custom_target(${target}_bin
        SOURCES ${bin_dir}/${target}.bin
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.bin
        DEPENDS ${target}
        COMMAND ${CMAKE_OBJCOPY}
            -O binary $<TARGET_FILE:${target}>
            ${bin_dir}/${target}.bin
    )

    add_custom_target(${target}_elf
        SOURCES ${bin_dir}/${target}.elf
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.elf
        DEPENDS ${target}
        COMMAND ${CMAKE_OBJCOPY}
            -O elf32-littlearm $<TARGET_FILE:${target}>
            ${bin_dir}/${target}.elf
    )

    add_custom_target(${target}_hex
        SOURCES ${bin_dir}/${target}.hex
    )
    add_custom_command(OUTPUT ${bin_dir}/${target}.hex
        DEPENDS ${target}
        COMMAND ${CMAKE_OBJCOPY}
            -O ihex $<TARGET_FILE:${target}>
            ${bin_dir}/${target}.hex
    )

    add_custom_target(${target}_binaries
        ALL
        DEPENDS ${target}_bin
        DEPENDS ${target}_elf
        DEPENDS ${target}_hex
    )
endmacro()

# A dummy macro to align with Armclang workaround
macro(tfm_toolchain_reload_compiler)
endmacro()
