#
# Copyright (c) 2021 - 2024, Nordic Semiconductor ASA.
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#

include(${CMAKE_CURRENT_LIST_DIR}/../common/config.cmake)

set(NRF_SOC_VARIANT nrf5340 CACHE STRING "nRF SoC Variant")

include(${PLATFORM_PATH}/common/nrf5340/config.cmake)

# Override the AEAD algorithm configuration
set(PS_CRYPTO_AEAD_ALG                  PSA_ALG_GCM CACHE STRING    "The AEAD algorithm to use for authenticated encryption in Protected Storage")
