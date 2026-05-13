
cmake_minimum_required(VERSION 3.18.1)

project("lc3")

include_directories(include)
#add_subdirectory(liblc3)
add_library(${CMAKE_PROJECT_NAME} SHARED
        # List C/C++ source files with relative paths to this CMakeLists.txt.
        liblc3.cpp

        liblc3/attdet.c
        liblc3/bits.c
        liblc3/bwdet.c
        liblc3/energy.c
        liblc3/lc3.c
        liblc3/ltpf.c
        liblc3/mdct.c
        liblc3/plc.c
        liblc3/sns.c
        liblc3/spec.c
        liblc3/tables.c
        liblc3/tns.c

        rnnoise/celt_lpc.c
        rnnoise/denoise.c
        rnnoise/kiss_fft.c
        rnnoise/pitch.c
        rnnoise/rnn.c
        rnnoise/rnn_data.c
        rnnoise/rnn_reader.c

        )

target_link_libraries(${CMAKE_PROJECT_NAME}
        # List libraries link to the target library
        android
        log)