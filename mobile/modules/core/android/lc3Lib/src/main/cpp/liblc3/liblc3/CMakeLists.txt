add_library(liblc
        STATIC
        attdet.c
        bits.c
        bwdet.c
        energy.c
        lc3.c
        ltpf.c
        mdct.c
        plc.c
        sns.c
        spec.c
        tables.c
        tns.c
        )

target_include_directories(liblc3 PUBLIC ../include)

#target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE liblc3)