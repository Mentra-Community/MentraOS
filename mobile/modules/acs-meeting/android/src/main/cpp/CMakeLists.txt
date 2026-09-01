cmake_minimum_required(VERSION 3.22.1)

project(mentra_acs_encoder_override)

add_library(
  mentra_acs_encoder_override
  SHARED
  acs_encoder_override.cpp
)

find_library(log_lib log)

target_link_libraries(
  mentra_acs_encoder_override
  ${CMAKE_DL_LIBS}
  ${log_lib}
)
