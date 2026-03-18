/*
 * Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

/** @file
 * @brief TFM IOCTL API header.
 */


#ifndef TFM_IOCTL_CORE_API_H__
#define TFM_IOCTL_CORE_API_H__

/**
 * @defgroup tfm_ioctl_api TFM IOCTL API
 * @{
 *
 */

#include <limits.h>
#include <tfm_platform_api.h>

#ifdef __cplusplus
extern "C" {
#endif

/** @brief Supported request types.
 */
enum tfm_platform_ioctl_core_reqest_types_t {
	TFM_PLATFORM_IOCTL_READ_SERVICE,
	TFM_PLATFORM_IOCTL_WRITE32_SERVICE,
	TFM_PLATFORM_IOCTL_GPIO_SERVICE,
	/* Last core service, start platform specific from this value. */
	TFM_PLATFORM_IOCTL_CORE_LAST
};

/** @brief Argument list for each platform read service.
 */
struct tfm_read_service_args_t {
	void *destination;
	uint32_t addr;
	size_t len;
};


/** @brief Output list for each read platform service
 */
struct tfm_read_service_out_t {
	uint32_t result;
};

/** @brief Argument list for each platform write32 service.
 */
struct tfm_write32_service_args_t {
	uint32_t addr;
	uint32_t value;
	uint32_t mask;
};
/** @brief Output list for each write32 platform service
 */

struct tfm_write32_service_out_t {
	uint32_t result;
};

enum tfm_gpio_service_type {
	/** Select which MCU / Subsystem controls the pin */
	TFM_GPIO_SERVICE_TYPE_PIN_MCU_SELECT = 0,
};

/** @brief Arguments for selecting the MCU to control a GPIO pin. */
struct tfm_gpio_service_args_mcu_select {
	uint32_t pin_number;
	uint32_t mcu;
};

/** @brief Argument list for each platform GPIO service */
struct tfm_gpio_service_args {
	uint32_t type;
	union {
		struct tfm_gpio_service_args_mcu_select mcu_select;
	};
};

/** @brief Output list for each GPIO platform service
 */
struct tfm_gpio_service_out {
	uint32_t result;
};

/**
 * @brief Perform a read operation.
 *
 * @param[out] destination   Pointer where read result is stored
 * @param[in]  addr          Address to read from
 * @param[in]  len           Number of bytes to read
 * @param[out] result        Result of operation
 *
 * @return Returns values as specified by the tfm_platform_err_t
 */
enum tfm_platform_err_t tfm_platform_mem_read(void *destination, uint32_t addr,
					      size_t len, uint32_t *result);

/**
 * @brief Perform a write32 operation.
 *
 * @param[in]  addr          Address to write to
 * @param[in]  value         32 bit value to write
 * @param[in]  mask          Mask applied to the write value
 * @param[out] result        An enum tfm_write32_service_result value
 *
 * @return Returns values as specified by the tfm_platform_err_t
 */
enum tfm_platform_err_t tfm_platform_mem_write32(uint32_t addr, uint32_t value,
						 uint32_t mask, uint32_t *result);

/** @brief Represents an accepted read range.
 */
struct tfm_read_service_range {
	uint32_t start;
	size_t size;
};

/** @brief Represents the accepted addresses and masks for write32 service.
 */
struct tfm_write32_service_address {
	uint32_t addr;
	uint32_t mask;
	const uint32_t *allowed_values;
	const uint32_t allowed_values_array_size;
};

enum tfm_write32_service_result {
	TFM_WRITE32_SERVICE_SUCCESS,
	TFM_WRITE32_SERVICE_ERROR_INVALID_ADDRESS,
	TFM_WRITE32_SERVICE_ERROR_INVALID_MASK,
	TFM_WRITE32_SERVICE_ERROR_INVALID_VALUE,
};

/**
 * @brief Perform a GPIO MCU select operation.
 *
 * @param pin_number         Pin_number.
 * @param mcu                MCU to control the pin, use nrf_gpio_pin_sel_t values.

 * @param[out] result        Result of operation
 *
 * @return Returns values as specified by the tfm_platform_err_t
 */
enum tfm_platform_err_t tfm_platform_gpio_pin_mcu_select(uint32_t pin_number, uint32_t mcu,
							 uint32_t *result);


#ifdef __cplusplus
}
#endif

/**
 * @}
 */

#endif /* TFM_IOCTL_CORE_API_H__ */
