/*
 * Copyright (c) 2023 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include "cmsis.h"
#include "tfm_hal_platform.h"

#if NRF_ALLOW_NON_SECURE_FAULT_HANDLING
#include "ns_fault_service.h"
#endif /* CONFIG_TFM_ALLOW_NON_SECURE_FAULT_HANDLING */

void tfm_hal_system_halt(void)
{
#if NRF_ALLOW_NON_SECURE_FAULT_HANDLING
	ns_fault_service_call_handler();
#endif

	/*
	 * Disable IRQs to stop all threads, not just the thread that
	 * halted the system.
	 */
	__disable_irq();

	/*
	 * Enter sleep to reduce power consumption and do it in a loop in
	 * case a signal wakes up the CPU.
	 */
	while (1) {
		__WFE();
	}
}

void tfm_hal_system_reset(void)
{
#if NRF_ALLOW_NON_SECURE_FAULT_HANDLING
	ns_fault_service_call_handler();
#endif

	NVIC_SystemReset();
}
