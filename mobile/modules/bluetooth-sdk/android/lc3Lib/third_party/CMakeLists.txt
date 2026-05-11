cmake_minimum_required(VERSION 3.4.1)
include(ExternalProject)

set(opus_tools_src ${CMAKE_CURRENT_SOURCE_DIR}/opus_tools/src)
ExternalProject_Add(external_opus_tools
        GIT_REPOSITORY    "https://github.com/xiph/opus-tools/"
        GIT_TAG           "14f650f64260115098d55fb91e1f83110cb628d3"
        SOURCE_DIR        "${opus_tools_src}"
        CONFIGURE_COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/build/include_files_helper.sh ${CMAKE_CURRENT_SOURCE_DIR}/build/
        COMMAND  ${CMAKE_COMMAND} -E copy
                ${CMAKE_CURRENT_BINARY_DIR}/build/libogg/${ANDROID_ABI}/include/ogg/config_types.h
                ${CMAKE_CURRENT_SOURCE_DIR}/../src/main/cpp/libogg/
        COMMAND ${CMAKE_COMMAND} ${opus_tools_src}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DANDROID_ABI=${ANDROID_ABI}
        -DCMAKE_INSTALL_PREFIX=${CMAKE_CURRENT_BINARY_DIR}/build/opus_tools/${ANDROID_ABI}
        BINARY_DIR ${CMAKE_CURRENT_BINARY_DIR}/build/opus_tools/${ANDROID_ABI}/lib/
        INSTALL_COMMAND  ""
        COMMAND
        ${CMAKE_COMMAND} -E copy
        ${CMAKE_CURRENT_BINARY_DIR}/build/opus_tools/${ANDROID_ABI}/lib/libopus_header.a
        ${CMAKE_CURRENT_SOURCE_DIR}/opus_tools/lib/${ANDROID_ABI}/
        )
