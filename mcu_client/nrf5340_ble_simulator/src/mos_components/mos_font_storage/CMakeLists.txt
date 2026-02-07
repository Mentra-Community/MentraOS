# Copyright (c) MentraOS Contributors
# SPDX-License-Identifier: Apache-2.0

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_sources(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_font_storage.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_binfont_lvgl.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_xbf_font.c
)
