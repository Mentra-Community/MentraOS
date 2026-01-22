/*
 * Copyright (c) 2021 - 2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#ifndef __RTE_DEVICE_H
#define __RTE_DEVICE_H

#include <zephyr/autoconf.h>

/* ARRAY_SIZE causes a conflict as it is defined both by TF-M and indirectly by devicetree.h */
#undef ARRAY_SIZE
#include <zephyr/devicetree.h>

#include <nrf-pinctrl.h>

#include <nrf.h>

#define UART_PIN_INIT(node_id, prop, idx) DT_PROP_BY_IDX(node_id, prop, idx),

#define RTE_USART_PINS(idx)                                                                        \
	{                                                                                          \
		DT_FOREACH_CHILD_VARGS(DT_PINCTRL_BY_NAME(DT_NODELABEL(uart##idx), default, 0),    \
				       DT_FOREACH_PROP_ELEM, psels, UART_PIN_INIT)                 \
	}

#define RTE_FLASH0 1

#if DOMAIN_NS == 1U

#ifdef NRF_UARTE0_S

#define RTE_USART0 1

#else /* NRF_UARTE0_S - 54L15 devices*/

/* Only UART20 and UART30 are supported for TF-M tests, which are the
 * Non-secure applications build via the TF-M build system
 */
#if defined(CONFIG_TFM_SECURE_UART30)
#define RTE_USART20 1
#else
#define RTE_USART30 1
#endif

#endif /* NRF_UARTE0_S */

#endif /* DOMAIN_NS == 1U */

/*
 * The defines RTE_USART0, RTE_USART1, etc. determine if
 * Driver_USART.c instantiates UART instance 0, 1, etc..
 */

#if defined(CONFIG_TFM_SECURE_UART0)
#define RTE_USART0 1
#endif

#if defined(CONFIG_TFM_SECURE_UART1)
#define RTE_USART1 1
#endif

#if defined(CONFIG_TFM_SECURE_UART00)
#define RTE_USART00 1
#endif

#if defined(CONFIG_TFM_SECURE_UART20)
#define RTE_USART20 1
#endif

#if defined(CONFIG_TFM_SECURE_UART21)
#define RTE_USART21 1
#endif

#if defined(CONFIG_TFM_SECURE_UART22)
#define RTE_USART22 1
#endif

#if defined(CONFIG_TFM_SECURE_UART30)
#define RTE_USART30 1
#endif

/*
 * Note that the defines RTE_USART0_PINS, RTE_USART1_PINS, etc. are
 * used by Driver_USART.c, but only when RTE_USART0, RTE_USART1
 * etc. are defined to 1.
 */
#define RTE_USART0_PINS RTE_USART_PINS(0)
#define RTE_USART1_PINS RTE_USART_PINS(1)

#define RTE_USART00_PINS RTE_USART_PINS(00)
#define RTE_USART20_PINS RTE_USART_PINS(20)
#define RTE_USART21_PINS RTE_USART_PINS(21)
#define RTE_USART22_PINS RTE_USART_PINS(22)
#define RTE_USART30_PINS RTE_USART_PINS(30)

#endif /* __RTE_DEVICE_H */
