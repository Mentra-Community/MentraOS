#
# Copyright (c) 2024 Nordic Semiconductor
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#

# This file is populated with custom configuration for TF-M to state that the PSA core is built externally
# This can be rewritten when solving NCSDK-XXXXX
set(PSA_CRYPTO_EXTERNAL_CORE                  ON    CACHE BOOL      "Enable building PSA core externally")

# This file is populated with paths needed building nrf_security with and without TF-M
# It is added to circumvent issues with install-targets inside TF-M and to unify the
# CMake code with Zephyr builds
set(NRFXLIB_DIR          /opt/nordic/ncs/v3.0.0/nrfxlib            CACHE STRING "nrfxlib folder")
set(NRF_SECURITY_ROOT    /opt/nordic/ncs/v3.0.0/nrf/subsys/nrf_security          CACHE STRING "nrf_security root folder")
set(OBERON_PSA_CORE_PATH /opt/nordic/ncs/v3.0.0/modules/crypto/oberon-psa-crypto  CACHE STRING "oberon-psa-core folder")
set(ARM_MBEDTLS_PATH     /opt/nordic/ncs/v3.0.0/modules/crypto/mbedtls            CACHE STRING "Mbed TLS folder")
set(NRF_DIR              /opt/nordic/ncs/v3.0.0/nrf                              CACHE STRING "NRF folder")

# This file is populated with the Mbed TLS config file names
set(MBEDTLS_CONFIG_FILE                 nrf-config.h                      CACHE STRING "Mbed TLS Config file")
set(MBEDTLS_PSA_CRYPTO_CONFIG_FILE      nrf-psa-crypto-config.h        CACHE STRING "PSA crypto config file (PSA_WANT)")
set(MBEDTLS_PSA_CRYPTO_USER_CONFIG_FILE nrf-psa-crypto-user-config.h   CACHE STRING "PSA crypto config file (PSA_NEED)")

# This file is populated with the generated include-folders for PSA interface (for main app, ns-services) as
# well as the include-folder for library build of the crypto toolbo with or without TF-M
set(PSA_CRYPTO_CONFIG_INTERFACE_PATH    /Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/generated/interface_nrf_security_psa CACHE STRING "Path used for generated PSA crypto configuratiosn for the interface")
set(PSA_CRYPTO_CONFIG_LIBRARY_PATH      /Users/loayyari/Documents/Github/MentraOS_TESTS/mcu_client/nrf5340/mentraos_nrf5340/build/mentraos_nrf5340/generated/library_nrf_security_psa CACHE STRING "Path used for generated PSA crypto for library builds")

# Defines used by including external_core.cmake multiple times (to clean up for CMake trace)
# This definitely needs to be reworked in upstream TF-M
set(EXTERNAL_CRYPTO_CORE_HANDLED_TFM_API_NS False CACHE BOOL "Use to ensure we add links only once")
set(EXTERNAL_CRYPTO_CORE_HANDLED_PSA_INTERFACE False CACHE BOOL "Use to ensure we add links only once")
set(EXTERNAL_CRYPTO_CORE_HANDLED_PSA_CRYPTO_CONFIG False CACHE BOOL "Use to ensure we add links only once")
set(EXTERNAL_CRYPTO_CORE_HANDLED_PSA_CRYPTO_LIBRARY_CONFIG False CACHE BOOL "Use to ensure we add links only once")
set(EXTERNAL_CRYPTO_CORE_HANDLED_TFM_PSA_ROT_PARTITION_CRYPTO False CACHE BOOL "Use to ensure we add links only once")
set(EXTERNAL_CRYPTO_CORE_HANDLED_TFM_SPRT False CACHE BOOL "Use to ensure we add links only once")
