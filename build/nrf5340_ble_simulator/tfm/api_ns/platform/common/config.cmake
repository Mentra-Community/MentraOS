#
# Copyright (c) 2021 - 2023, Nordic Semiconductor ASA.
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#

# Override the platform crypto key handling
set(PLATFORM_DEFAULT_CRYPTO_KEYS              FALSE       CACHE BOOL      "Use default crypto keys implementation.")

set(PLATFORM_DEFAULT_SYSTEM_RESET_HALT        OFF         CACHE BOOL      "Use default system reset/halt implementation")

# Disable crypto regression tests that are not supported
set(TFM_CRYPTO_TEST_ALG_CFB                   OFF         CACHE BOOL      "Test CFB cryptography mode")
set(TFM_CRYPTO_TEST_ALG_OFB                   OFF         CACHE BOOL      "Test OFB cryptography mode")

# Always enable the nonsecure storage partition.
# It will still be excluded if the partition manager excludes it.
set(NRF_NS_STORAGE                            ON          CACHE BOOL      "Enable non-secure storage partition")
set(PLATFORM_DEFAULT_ATTEST_HAL               OFF         CACHE BOOL      "Use default attest hal implementation.")

set(NRF_ALLOW_NON_SECURE_RESET                OFF         CACHE BOOL      "Allow system reset calls from Non-Secure")
set(NRF_ALLOW_NON_SECURE_FAULT_HANDLING       OFF         CACHE BOOL      "Allow Non-Secure to handle Secure faults triggered by Non-Secure")

set(TFM_DUMMY_PROVISIONING                    OFF         CACHE BOOL      "Provision with dummy values. NOT to be used in production")
set(PLATFORM_DEFAULT_PROVISIONING             OFF         CACHE BOOL      "Use default provisioning implementation")
set(NRF_PROVISIONING                          OFF         CACHE BOOL      "Use Nordic provisioning implementation")
set(CONFIG_NFCT_PINS_AS_GPIOS                 OFF         CACHE BOOL      "Use NFCT pins as GPIOs.")
set(CONFIG_NRF_TRACE_PORT                     OFF         CACHE BOOL      "Enable trace port.")
set(CONFIG_NRF_APPROTECT_LOCK                 OFF         CACHE BOOL      "Enable approtect.")
set(CONFIG_NRF_APPROTECT_USER_HANDLING        OFF         CACHE BOOL      "Enable approtect user handling.")
set(CONFIG_NRF_SECURE_APPROTECT_LOCK          OFF         CACHE BOOL      "Enable secure approtect.")
set(CONFIG_NRF_SECURE_APPROTECT_USER_HANDLING OFF         CACHE BOOL      "Enable secure approtect user handling.")

set(CONFIG_HW_UNIQUE_KEY                      ON          CACHE BOOL      "Enable Hardware Unique Key")
set(CONFIG_HW_UNIQUE_KEY_RANDOM               ON          CACHE BOOL      "Write a new Hardware Unique Key if none exists")
