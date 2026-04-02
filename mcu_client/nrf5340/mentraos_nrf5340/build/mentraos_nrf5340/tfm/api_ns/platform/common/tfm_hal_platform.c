/*
 * Copyright (c) 2021 - 2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include <zephyr/autoconf.h>

#if defined(TFM_PARTITION_CRYPTO) && defined(CONFIG_HAS_HW_NRF_CC3XX)
#include <nrf_cc3xx_platform.h>
#include <nrf_cc3xx_platform_ctr_drbg.h>
#endif

#if defined(NRF_PROVISIONING)
#include "tfm_attest_hal.h"
#endif /* defined(NRF_PROVISIONING) */

#include "tfm_hal_platform.h"
#include "tfm_hal_platform_common.h"
#include "cmsis.h"
#include "uart_stdout.h"
#include "tfm_spm_log.h"

#ifdef CONFIG_HW_UNIQUE_KEY
#include "hw_unique_key.h"
#endif

#include "config_tfm.h"
#include "exception_info.h"
#include "tfm_arch.h"

#if defined(TFM_PARTITION_CRYPTO)
static enum tfm_hal_status_t crypto_platform_init(void)
{
	int err = 0;

#ifdef CONFIG_HAS_HW_NRF_CC3XX
	/* Initialize the nrf_cc3xx runtime */
#if !CRYPTO_RNG_MODULE_ENABLED
	err = nrf_cc3xx_platform_init_no_rng();
#elif defined(CONFIG_PSA_NEED_CC3XX_CTR_DRBG_DRIVER)
	err = nrf_cc3xx_platform_init();
#elif defined(CONFIG_PSA_NEED_CC3XX_HMAC_DRBG_DRIVER)
	err = nrf_cc3xx_platform_init_hmac_drbg();
#else
#error "Please enable either PSA_WANT_ALG_CTR_DRBG or PSA_WANT_ALG_HMAC_DRBG"
#endif

	if (err) {
		return TFM_HAL_ERROR_BAD_STATE;
	}
#endif /* CONFIG_HAS_HW_NRF_CC3XX */

#ifdef CONFIG_HW_UNIQUE_KEY_RANDOM
	if (!hw_unique_key_are_any_written()) {
		SPMLOG_INFMSG("Writing random Hardware Unique Keys to the KMU.\r\n");
		err = hw_unique_key_write_random();
		if (err != HW_UNIQUE_KEY_SUCCESS) {
			SPMLOG_DBGMSGVAL("hw_unique_key_write_random failed with error code:", err);
			return TFM_HAL_ERROR_BAD_STATE;
		}
		SPMLOG_INFMSG("Success\r\n");
	}
#endif /* CONFIG_HW_UNIQUE_KEY_RANDOM */
	(void)err;
	return TFM_HAL_SUCCESS;
}
#endif /* defined(TFM_PARTITION_CRYPTO) */

/* To write into AIRCR register, 0x5FA value must be written to the VECTKEY field,
 * otherwise the processor ignores the write.
 */
#define AIRCR_VECTKEY_PERMIT_WRITE ((0x5FAUL << SCB_AIRCR_VECTKEY_Pos))

static void allow_nonsecure_reset(void)
{
	uint32_t reg_value = SCB->AIRCR;

	/* Clear SCB_AIRCR_VECTKEY value */
	reg_value &= ~(uint32_t)(SCB_AIRCR_VECTKEY_Msk);

	/* Clear SCB_AIRC_SYSRESETREQS value */
	reg_value &= ~(uint32_t)(SCB_AIRCR_SYSRESETREQS_Msk);

	/* Add VECTKEY value needed to write the register. */
	reg_value |= (uint32_t)(AIRCR_VECTKEY_PERMIT_WRITE);

	SCB->AIRCR = reg_value;
}

#if CONFIG_NRF_GPIO0_PIN_MASK_SECURE || CONFIG_NRF_GPIO1_PIN_MASK_SECURE
static void maybe_log_for_gpio_port(uint32_t gpio_port, uint32_t secure_pin_mask)
{
	if (secure_pin_mask == 0) {
		return;
	}

	SPMLOG_INFMSG("Pins have been configured as secure.\r\n");
	SPMLOG_INFMSGVAL("GPIO port: ", gpio_port);

	for (int i = 0; i < 32; i++) {
		if (secure_pin_mask & (1 << i)) {
			SPMLOG_INFMSGVAL("Pin: ", i);
		}
	}
}
#endif

static void log_pin_security_configuration(void)
{
#if CONFIG_NRF_GPIO0_PIN_MASK_SECURE
	maybe_log_for_gpio_port(0, CONFIG_NRF_GPIO0_PIN_MASK_SECURE);
#endif
#if CONFIG_NRF_GPIO1_PIN_MASK_SECURE
	maybe_log_for_gpio_port(1, CONFIG_NRF_GPIO1_PIN_MASK_SECURE);
#endif
#if !CONFIG_NRF_GPIO0_PIN_MASK_SECURE && !CONFIG_NRF_GPIO1_PIN_MASK_SECURE
	SPMLOG_INFMSG("All pins have been configured as non-secure\r\n");
#endif
}

enum tfm_hal_status_t tfm_hal_platform_init(void)
{
	enum tfm_hal_status_t status;

	status = tfm_hal_platform_common_init();
	if (status != TFM_HAL_SUCCESS) {
		return status;
	}

#if defined(TFM_PARTITION_CRYPTO)
	status = crypto_platform_init();
	if (status != TFM_HAL_SUCCESS) {
		return status;
	}
#endif /* defined(TFM_PARTITION_CRYPTO) */

#if defined(NRF_ALLOW_NON_SECURE_RESET)
	allow_nonsecure_reset();
#endif

/* When NRF_PROVISIONING is enabled we can either be in the lifecycle state "provisioning" or
 * "secured", we don't support any other lifecycle states. This ensures that TF-M will not
 * continue booting when an unsupported state is present.
 */
#if defined(NRF_PROVISIONING)
	enum tfm_security_lifecycle_t lcs = tfm_attest_hal_get_security_lifecycle();

	if (lcs != TFM_SLC_PSA_ROT_PROVISIONING && lcs != TFM_SLC_SECURED) {
		SPMLOG_ERRMSGVAL("Invalid LCS: ", lcs);
		SPMLOG_DBGMSG("Ensure that the device has been provisioned.\r\n");
		return TFM_HAL_ERROR_BAD_STATE;
	}
#endif /* defined(NRF_PROVISIONING) */

	log_pin_security_configuration();

	return TFM_HAL_SUCCESS;
}
