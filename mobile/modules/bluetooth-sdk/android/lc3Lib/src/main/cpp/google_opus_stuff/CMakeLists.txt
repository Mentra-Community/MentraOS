# Builds the ogg and opus encoder library which used third party module.
cmake_minimum_required(VERSION 3.22.1)

# set related path of third party libraries.
set(third_party_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party)

# libogg library refer from https://github.com/xiph/ogg.
set(libogg_INCLUDE ${third_party_DIR}/libogg/include)
set(libogg_LIB ${third_party_DIR}/libogg/lib/${ANDROID_ABI})
add_library(lib_ogg STATIC IMPORTED)
set_target_properties(lib_ogg PROPERTIES IMPORTED_LOCATION ${libogg_LIB}/libogg.a)

# libopus library refer from https://github.com/xiph/opus.
set(libopus_INCLUDE ${third_party_DIR}/libopus/include)
set(libopus_LIB ${third_party_DIR}/libopus/lib/${ANDROID_ABI})
add_library(lib_opus STATIC IMPORTED)
set_target_properties(lib_opus PROPERTIES IMPORTED_LOCATION ${libopus_LIB}/libopus.a)

# opus-tools https://github.com/xiph/opus-tools.
set(opus_tools_INCLUDE ${third_party_DIR}/opus_tools/include)
set(opus_tools_LIB ${third_party_DIR}/opus_tools/lib/${ANDROID_ABI})
add_library(lib_opus_header STATIC IMPORTED)
set_target_properties(lib_opus_header PROPERTIES IMPORTED_LOCATION
        ${opus_tools_LIB}/libopus_header.a)

# Build ogg_opus_encoder_tool shared lib.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=gnu++11")
add_library(ogg_opus_encoder_tool SHARED ogg_opus_encoder.cc)
target_include_directories(ogg_opus_encoder_tool PRIVATE ${libogg_INCLUDE})
target_link_libraries(ogg_opus_encoder_tool lib_opus lib_ogg lib_opus_header)
