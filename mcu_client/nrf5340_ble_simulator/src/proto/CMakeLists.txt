

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/mentraos_ble.pb.c)
  target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/mentraos_ble.pb.c)
  target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
elseif(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/../mentraos_ble.pb.c)
  target_sources(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../mentraos_ble.pb.c)
  target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/..)
endif()
