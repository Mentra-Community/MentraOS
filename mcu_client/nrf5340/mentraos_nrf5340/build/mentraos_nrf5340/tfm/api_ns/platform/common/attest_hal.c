/*
 * Copyright (c) 2018-2021, Arm Limited. All rights reserved.
 * Copyright (c) 2022 Nordic Semiconductor ASA.
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 *
 */

#include <stddef.h>
#include <stdint.h>
#include <psa/error.h>
#include <psa/crypto.h>
#include "tfm_attest_hal.h"
#include "tfm_plat_boot_seed.h"
#include "tfm_plat_device_id.h"
#include "tfm_strnlen.h"
#include "nrf_provisioning.h"
#include <bl_storage.h>

#ifdef CONFIG_NRFX_NVMC
#include <nrfx_nvmc.h>
#endif
#ifdef CONFIG_HAS_HW_NRF_CC3XX
#include <nrf_cc3xx_platform.h>
#endif

#if defined(CONFIG_CRACEN_HW_PRESENT)
static bool boot_seed_set;
static uint8_t boot_seed[BOOT_SEED_SIZE];
#endif

static enum tfm_security_lifecycle_t map_bl_storage_lcs_to_tfm_slc(enum lcs lcs)
{
	switch (lcs) {
	case BL_STORAGE_LCS_ASSEMBLY:
		return TFM_SLC_ASSEMBLY_AND_TEST;
	case BL_STORAGE_LCS_PROVISIONING:
		return TFM_SLC_PSA_ROT_PROVISIONING;
	case BL_STORAGE_LCS_SECURED:
		return TFM_SLC_SECURED;
	case BL_STORAGE_LCS_DECOMMISSIONED:
		return TFM_SLC_DECOMMISSIONED;
	default:
		return TFM_SLC_UNKNOWN;
	}
}

static enum lcs map_tfm_slc_to_bl_storage_lcs(enum tfm_security_lifecycle_t lcs)
{
	switch (lcs) {
	case TFM_SLC_ASSEMBLY_AND_TEST:
		return BL_STORAGE_LCS_ASSEMBLY;
	case TFM_SLC_PSA_ROT_PROVISIONING:
		return BL_STORAGE_LCS_PROVISIONING;
	case TFM_SLC_SECURED:
		return BL_STORAGE_LCS_SECURED;
	case TFM_SLC_DECOMMISSIONED:
		return BL_STORAGE_LCS_DECOMMISSIONED;
	default:
		return BL_STORAGE_LCS_UNKNOWN;
	}
}

enum tfm_security_lifecycle_t tfm_attest_hal_get_security_lifecycle(void)
{
	int err;
	enum lcs otp_lcs;

	err = read_life_cycle_state(&otp_lcs);
	if (err != 0) {
		return TFM_SLC_UNKNOWN;
	}

	return map_bl_storage_lcs_to_tfm_slc(otp_lcs);
}

int tfm_attest_update_security_lifecycle_otp(enum tfm_security_lifecycle_t slc)
{
	enum lcs next_lcs;

	next_lcs = map_tfm_slc_to_bl_storage_lcs(slc);

	return update_life_cycle_state(next_lcs);
}

static const char *get_attestation_profile(void)
{
#if defined(CONFIG_TFM_ATTEST_TOKEN_PROFILE_PSA_IOT_1)
	return "PSA_IOT_PROFILE_1";
#elif defined(CONFIG_TFM_ATTEST_TOKEN_PROFILE_PSA_2_0_0)
	return "http://arm.com/psa/2.0.0";
#elif defined(CONFIG_TFM_ATTEST_TOKEN_PROFILE_ARM_CCA)
	return "http://arm.com/CCA-SSD/1.0.0";
#else
#error "Attestation token profile not defined"
#endif
}

enum tfm_plat_err_t tfm_attest_hal_get_profile_definition(uint32_t *size, uint8_t *buf)
{
	const char *profile = get_attestation_profile();
	uint32_t profile_len = strlen(profile);

	if (*size < profile_len) {
		return TFM_PLAT_ERR_SYSTEM_ERR;
	}

	memcpy(buf, profile, profile_len);
	*size = profile_len;

	return TFM_PLAT_ERR_SUCCESS;
}

enum tfm_plat_err_t tfm_plat_get_boot_seed(uint32_t size, uint8_t *buf)
{
#if defined(CONFIG_HAS_HW_NRF_CC3XX)
	int nrf_err;

	_Static_assert(NRF_CC3XX_PLATFORM_TFM_BOOT_SEED_SIZE == BOOT_SEED_SIZE,
		"NRF_CC3XX_PLATFORM_TFM_BOOT_SEED_SIZE must match BOOT_SEED_SIZE");
	if (size != NRF_CC3XX_PLATFORM_TFM_BOOT_SEED_SIZE) {
		return TFM_PLAT_ERR_INVALID_INPUT;
	}

	nrf_err = nrf_cc3xx_platform_get_boot_seed(buf);
	if (nrf_err != NRF_CC3XX_PLATFORM_SUCCESS) {
		return TFM_PLAT_ERR_SYSTEM_ERR;
	}
#elif defined(CONFIG_CRACEN_HW_PRESENT)
	if (!boot_seed_set) {
		psa_status_t psa_err = psa_generate_random(boot_seed, sizeof(boot_seed));

		if (psa_err != PSA_SUCCESS) {
			return TFM_PLAT_ERR_SYSTEM_ERR;
		}

		boot_seed_set = true;
	}

	if (size != BOOT_SEED_SIZE) {
		return TFM_PLAT_ERR_INVALID_INPUT;
	}
	memcpy(buf, boot_seed, size);
#else
#error "No crypto hardware to generate boot seed available."
#endif

	return TFM_PLAT_ERR_SUCCESS;
}

enum tfm_plat_err_t tfm_plat_get_implementation_id(uint32_t *size, uint8_t *buf)
{
	*size = BL_STORAGE_IMPLEMENTATION_ID_SIZE;
	read_implementation_id_from_otp(buf);

	return TFM_PLAT_ERR_SUCCESS;
}

#if CONFIG_TFM_ATTEST_INCLUDE_OPTIONAL_CLAIMS

enum tfm_plat_err_t tfm_plat_get_cert_ref(uint32_t *size, uint8_t *buf)
{
	if (read_variable_data(BL_VARIABLE_DATA_TYPE_PSA_CERTIFICATION_REFERENCE, buf, size)) {
		return TFM_PLAT_ERR_SYSTEM_ERR;
	}

	return TFM_PLAT_ERR_SUCCESS;
}

enum tfm_plat_err_t tfm_attest_hal_get_verification_service(uint32_t *size, uint8_t *buf)
{
	const char *url = CONFIG_TFM_ATTEST_VERIFICATION_SERVICE_URL;
	uint32_t url_len = strlen(url);

	if (*size < url_len) {
		return TFM_PLAT_ERR_SYSTEM_ERR;
	}

	memcpy(buf, url, url_len);
	*size = url_len;

	return TFM_PLAT_ERR_SUCCESS;
}

#endif /* CONFIG_TFM_ATTEST_INCLUDE_OPTIONAL_CLAIMS */
