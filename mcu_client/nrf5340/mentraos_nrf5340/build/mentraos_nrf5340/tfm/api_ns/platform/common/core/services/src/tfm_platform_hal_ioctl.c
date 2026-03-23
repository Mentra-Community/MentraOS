/*
 * Copyright (c) 2024, Arm Limited. All rights reserved.
 * Copyright (c) 2021-2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include <platform/include/tfm_platform_system.h>
#include <tfm_hal_device_header.h>
#include <stdio.h>
#include <tfm_ioctl_core_api.h>
#include <string.h>
#include <arm_cmse.h>
#include <array.h>
#include <tfm_hal_isolation.h>

/* This contains the user provided allowed ranges */
#include <tfm_platform_user_memory_ranges.h>

#include <hal/nrf_gpio.h>
#ifdef NRF91_SERIES
#include <nrfx_nvmc.h>
#endif

#include "handle_attr.h"

enum tfm_platform_err_t
tfm_platform_hal_read_service(const psa_invec  *in_vec,
			      const psa_outvec *out_vec)
{
	struct tfm_read_service_args_t *args;
	struct tfm_read_service_out_t *out;
	enum tfm_hal_status_t status;
	enum tfm_platform_err_t err;
	uintptr_t boundary = (1 << HANDLE_ATTR_NS_POS) &
	                      HANDLE_ATTR_NS_MASK;
	uint32_t attr = TFM_HAL_ACCESS_READWRITE;

	if (in_vec->len != sizeof(struct tfm_read_service_args_t) ||
	    out_vec->len != sizeof(struct tfm_read_service_out_t)) {
		return TFM_PLATFORM_ERR_INVALID_PARAM;
	}

	args = (struct tfm_read_service_args_t *)in_vec->base;
	out = (struct tfm_read_service_out_t *)out_vec->base;

	/* Assume failure, unless valid region is hit in the loop */
	out->result = -1;
	err = TFM_PLATFORM_ERR_INVALID_PARAM;

	if (args->destination == NULL || args->len <= 0) {
		return TFM_PLATFORM_ERR_INVALID_PARAM;
	}

	status = tfm_hal_memory_check(boundary, (uintptr_t)args->destination,
	                              args->len, attr);
	if (status != TFM_HAL_SUCCESS) {
		return TFM_PLATFORM_ERR_INVALID_PARAM;
	}

	for (size_t i = 0; i < ARRAY_SIZE(ranges); i++) {
		uint32_t start = ranges[i].start;
		uint32_t size = ranges[i].size;

		if (args->addr >= start &&
		    args->addr + args->len <= start + size) {
#ifdef NRF91_SERIES
			if (start >= NRF_UICR_S_BASE &&
			    start < (NRF_UICR_S_BASE + sizeof(NRF_UICR_Type))) {
				/* Range is inside UICR. Some nRF platforms need special handling */
				uint32_t *src = (uint32_t *)args->addr;
				uint32_t *dst = (uint32_t *)args->destination;
				uint32_t uicr_end = NRF_UICR_S_BASE + sizeof(NRF_UICR_Type);

				if (!IS_ALIGNED(src, sizeof(uint32_t)) ||
				    (args->len % sizeof(uint32_t)) != 0 ||
				    (args->addr + args->len) > uicr_end) {
					return TFM_PLATFORM_ERR_NOT_SUPPORTED;
				}

				while (args->len) {
					*dst++ = nrfx_nvmc_uicr_word_read(src++);
					args->len -= sizeof(uint32_t);
				}
				out->result = 0;
				err = TFM_PLATFORM_ERR_SUCCESS;
				break;
			}
#endif
			memcpy(args->destination,
			       (const void *)args->addr,
			       args->len);
			out->result = 0;
			err = TFM_PLATFORM_ERR_SUCCESS;
			break;
		}
	}

	return err;
}

#if NRF_GPIO_HAS_SEL
static bool valid_mcu_select(uint32_t mcu)
{
	switch (mcu) {
#if defined(NRF54L15_XXAA)
	case NRF_GPIO_PIN_SEL_GPIO:
	case NRF_GPIO_PIN_SEL_VPR:
	case NRF_GPIO_PIN_SEL_GRTC:
#else
	case NRF_GPIO_PIN_SEL_APP:
	case NRF_GPIO_PIN_SEL_NETWORK:
	case NRF_GPIO_PIN_SEL_PERIPHERAL:
	case NRF_GPIO_PIN_SEL_TND:
#endif
		return true;
	default:
		return false;
	}
}

static uint32_t gpio_service_mcu_select(struct tfm_gpio_service_args * args)
{
	if (nrf_gpio_pin_present_check(args->mcu_select.pin_number) &&
	    valid_mcu_select(args->mcu_select.mcu)) {
		nrf_gpio_pin_control_select(args->mcu_select.pin_number, args->mcu_select.mcu);
		return 0;
	} else {
		return -1;
	}
}

enum tfm_platform_err_t
tfm_platform_hal_gpio_service(const psa_invec  *in_vec, const psa_outvec *out_vec)
{
	struct tfm_gpio_service_args *args;
	struct tfm_gpio_service_out *out;

	if (in_vec->len != sizeof(struct tfm_gpio_service_args) ||
	    out_vec->len != sizeof(struct tfm_gpio_service_out)) {
		return TFM_PLATFORM_ERR_INVALID_PARAM;
	}

	args = (struct tfm_gpio_service_args *)in_vec->base;
	out = (struct tfm_gpio_service_out *)out_vec->base;
	out->result = -1;

	switch(args->type)
	{
	case TFM_GPIO_SERVICE_TYPE_PIN_MCU_SELECT:
		out->result = gpio_service_mcu_select(args);
		break;
	default:
		return TFM_PLATFORM_ERR_NOT_SUPPORTED;
	}


	return TFM_PLATFORM_ERR_SUCCESS;
}
#endif /* NRF_GPIO_HAS_SEL */

enum tfm_platform_err_t tfm_platform_hal_write32_service(const psa_invec *in_vec,
							 const psa_outvec *out_vec)
{
	uint32_t addr;
	uint32_t mask;
	uint32_t allowed_values_array_size;

	struct tfm_write32_service_args_t *args;
	struct tfm_write32_service_out_t *out;

	enum tfm_platform_err_t err;

	if (in_vec->len != sizeof(struct tfm_write32_service_args_t) ||
	    out_vec->len != sizeof(struct tfm_write32_service_out_t)) {
		return TFM_PLATFORM_ERR_INVALID_PARAM;
	}

	args = (struct tfm_write32_service_args_t *)in_vec->base;
	out = (struct tfm_write32_service_out_t *)out_vec->base;

	/* Assume failure, in case we don't find a match */
	out->result = TFM_WRITE32_SERVICE_ERROR_INVALID_ADDRESS;
	err = TFM_PLATFORM_ERR_INVALID_PARAM;

	for (size_t i = 0; i < ARRAY_SIZE(tfm_write32_service_addresses); i++) {
		addr = tfm_write32_service_addresses[i].addr;
		mask = tfm_write32_service_addresses[i].mask;
		allowed_values_array_size =
			tfm_write32_service_addresses[i].allowed_values_array_size;

		if (args->addr == addr) {
			out->result = TFM_WRITE32_SERVICE_ERROR_INVALID_MASK;

			if (args->mask == mask) {
				/* Check for allowed values if provided */
				if (allowed_values_array_size > 0 &&
				    tfm_write32_service_addresses[i].allowed_values != NULL) {
					bool is_value_allowed = false;

					for (int j = 0; j < allowed_values_array_size; j++) {

						const uint32_t allowed_value =
							tfm_write32_service_addresses[i]
								.allowed_values[j];

						if (allowed_value == (args->value & args->mask)) {
							is_value_allowed = true;
							break;
						}
					}

					if (!is_value_allowed) {
						out->result =
							TFM_WRITE32_SERVICE_ERROR_INVALID_VALUE;
						break;
					}
				}

				uint32_t new_value = *(uint32_t *)addr;
				/* Invert the mask to convert the masked bits to 0 first */
				new_value &= ~args->mask;
				new_value |= (args->value & args->mask);
				*(uint32_t *)addr = new_value;

				out->result = TFM_WRITE32_SERVICE_SUCCESS;
				err = TFM_PLATFORM_ERR_SUCCESS;
				break;
			}
		}
	}

	return err;
}
