/*
 * Copyright (c) 2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include "tfm_plat_otp.h"

enum tfm_plat_err_t tfm_plat_otp_init(void)
{
	return TFM_PLAT_ERR_SUCCESS;
}

enum tfm_plat_err_t tfm_plat_otp_read(enum tfm_otp_element_id_t id, size_t out_len, uint8_t *out)
{
	return TFM_PLAT_ERR_UNSUPPORTED;
}

enum tfm_plat_err_t tfm_plat_otp_write(enum tfm_otp_element_id_t id, size_t in_len,
				       const uint8_t *in)
{
	return TFM_PLAT_ERR_UNSUPPORTED;
}

enum tfm_plat_err_t tfm_plat_otp_get_size(enum tfm_otp_element_id_t id, size_t *size)
{
	return TFM_PLAT_ERR_UNSUPPORTED;
}
