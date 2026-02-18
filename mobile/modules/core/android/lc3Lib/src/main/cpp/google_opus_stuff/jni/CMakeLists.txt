#build for ogg_opus_encoder shared library
cmake_minimum_required(VERSION 3.22.1)

add_library(ogg_opus_encoder SHARED ogg_opus_encoder.cc ../ogg_opus_encoder.cc)

# Include libraries needed for ogg_opus_encoder
target_link_libraries(ogg_opus_encoder ogg_opus_encoder_tool)
