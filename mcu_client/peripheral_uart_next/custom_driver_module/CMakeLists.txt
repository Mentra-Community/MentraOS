# @Author       : Cole
# @Date         : 2025-07-31 10:40:40
# @LastEditTime : 2025-07-31 17:36:01
# @FilePath     : CMakeLists.txt
# @Description  : 
# Copyright (c) MentraOS Contributors 2025 
# SPDX-License-Identifier: Apache-2.0
 

cmake_minimum_required(VERSION 3.21)
# Subdirectories
add_subdirectory(drivers)

# Include headers
zephyr_include_directories(drivers)
