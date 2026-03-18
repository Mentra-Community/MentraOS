# Install script for directory: /opt/nordic/ncs/v3.0.0/zephyr/drivers

# Set the install prefix
if(NOT DEFINED CMAKE_INSTALL_PREFIX)
  set(CMAKE_INSTALL_PREFIX "/usr/local")
endif()
string(REGEX REPLACE "/$" "" CMAKE_INSTALL_PREFIX "${CMAKE_INSTALL_PREFIX}")

# Set the install configuration name.
if(NOT DEFINED CMAKE_INSTALL_CONFIG_NAME)
  if(BUILD_TYPE)
    string(REGEX REPLACE "^[^A-Za-z0-9_]+" ""
           CMAKE_INSTALL_CONFIG_NAME "${BUILD_TYPE}")
  else()
    set(CMAKE_INSTALL_CONFIG_NAME "")
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
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/disk/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/firmware/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/interrupt_controller/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/misc/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/pcie/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/usb/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/usb_c/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/audio/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/bluetooth/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/clock_control/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/console/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/display/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/entropy/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/flash/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/gpio/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/i2c/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/input/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/led/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/mbox/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/mfd/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/pinctrl/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/regulator/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/sensor/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/spi/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/timer/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/zephyr/drivers/watchdog/cmake_install.cmake")
endif()

