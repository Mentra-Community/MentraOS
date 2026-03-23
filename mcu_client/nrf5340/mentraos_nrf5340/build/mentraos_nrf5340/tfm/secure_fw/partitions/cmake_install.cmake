# Install script for directory: /opt/nordic/ncs/v3.0.0/modules/tee/tf-m/trusted-firmware-m/secure_fw/partitions

# Set the install prefix
if(NOT DEFINED CMAKE_INSTALL_PREFIX)
  set(CMAKE_INSTALL_PREFIX "/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/api_ns")
endif()
string(REGEX REPLACE "/$" "" CMAKE_INSTALL_PREFIX "${CMAKE_INSTALL_PREFIX}")

# Set the install configuration name.
if(NOT DEFINED CMAKE_INSTALL_CONFIG_NAME)
  if(BUILD_TYPE)
    string(REGEX REPLACE "^[^A-Za-z0-9_]+" ""
           CMAKE_INSTALL_CONFIG_NAME "${BUILD_TYPE}")
  else()
    set(CMAKE_INSTALL_CONFIG_NAME "MinSizeRel")
  endif()
  message(STATUS "Install configuration: \"${CMAKE_INSTALL_CONFIG_NAME}\"")
endif()

# Set the component getting installed.
if(NOT CMAKE_INSTALL_COMPONENT)
  if(COMPONENT)
    message(STATUS "Install component: \"${COMPONENT}\"")
    set(CMAKE_INSTALL_COMPONENT "${COMPONENT}")
  else()
    set(CMAKE_INSTALL_COMPONENT)
  endif()
endif()

# Is this installation the result of a crosscompile?
if(NOT DEFINED CMAKE_CROSSCOMPILING)
  set(CMAKE_CROSSCOMPILING "TRUE")
endif()

# Set default install directory permissions.
if(NOT DEFINED CMAKE_OBJDUMP)
  set(CMAKE_OBJDUMP "/opt/nordic/ncs/toolchains/ef4fc6722e/opt/zephyr-sdk/arm-zephyr-eabi/bin/arm-zephyr-eabi-objdump")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/lib/runtime/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/crypto/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/initial_attestation/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/protected_storage/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/internal_trusted_storage/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/platform/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/firmware_update/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/ns_agent_tz/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/tfm/secure_fw/partitions/ns_agent_mailbox/cmake_install.cmake")
endif()

