/*
 * Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */


#include "nrf.h"
#include <stdint.h>
#include "tfm_platform_api.h"
#include "tfm_ioctl_core_api.h"

enum tfm_platform_err_t tfm_platform_mem_read(void *destination, uint32_t addr,
					      size_t len, uint32_t *result)
{
	psa_status_t ret;
	psa_invec in_vec;
	psa_outvec out_vec;
	struct tfm_read_service_args_t args;
	struct tfm_read_service_out_t out;

	in_vec.base = (const void *)&args;
	in_vec.len = sizeof(args);

	out_vec.base = (void *)&out;
	out_vec.len = sizeof(out);

	args.destination = destination;
	args.addr = addr;
	args.len = len;

	ret = tfm_platform_ioctl(TFM_PLATFORM_IOCTL_READ_SERVICE, &in_vec,
				 &out_vec);

	return (enum tfm_platform_err_t) ret;
}

enum tfm_platform_err_t tfm_platform_gpio_pin_mcu_select(uint32_t pin_number, uint32_t mcu,
							 uint32_t *result)
{
#if defined(GPIO_PIN_CNF_MCUSEL_Msk)
	enum tfm_platform_err_t ret;
	psa_invec in_vec;
	psa_outvec out_vec;
	struct tfm_gpio_service_args args;
	struct tfm_gpio_service_out out;

	args.type = TFM_GPIO_SERVICE_TYPE_PIN_MCU_SELECT;
	args.mcu_select.pin_number = pin_number;
	args.mcu_select.mcu = mcu;

	in_vec.base = (const void *)&args;
	in_vec.len = sizeof(args);

	out_vec.base = (void *)&out;
	out_vec.len = sizeof(out);

	ret = tfm_platform_ioctl(TFM_PLATFORM_IOCTL_GPIO_SERVICE, &in_vec,
				 &out_vec);

	*result = out.result;

	return ret;
#else
	return TFM_PLATFORM_ERR_NOT_SUPPORTED;
#endif
}
