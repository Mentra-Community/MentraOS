/*
 * Copyright (c) 2023 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include "cmsis.h"
#include "tfm_spm_log.h"
#include "config_tfm.h"
#include "exception_info.h"
#include "nrf_exception_info.h"
#include "tfm_arch.h"
#include "tfm_ioctl_api.h"
#include <tfm_hal_isolation.h>
#include "handle_attr.h"

/* The goal of this feature is to allow the non-secure to handle the exceptions that are
 * triggered by non-secure but the exception is targeting secure.
 *
 * Banked Exceptions:
 * These exceptions have their individual pending bits and will target the security state
 * that they are taken from.
 *
 * These exceptions are banked:
 *  - HardFault
 *  - MemManageFault
 *  - UsageFault
 *  - SVCall
 *  - PendSV
 *  - Systick
 *
 * These exceptions are not banked:
 *  - Reset
 *  - NMI
 *  - BusFault
 *  - SecureFault
 *  - DebugMonitor
 *  - External Interrupt
 *
 * AICR.PRIS bit:
 * Prioritize Secure interrupts. All secure exceptions take priority over the non-secure
 * TF-M enables this
 *
 * AICR.BFHFNMINS bit:
 * Enable BusFault HardFault and NMI to target non-secure.
 * Since HardFault is banked this wil target the security state it is taken from, the others
 * will always target non-secure.
 * The effect of enabling this and PRIS at the same time is UNDEFINED.
 *
 * External interrupts target security state based on NVIC target state configuration.
 * The SPU interrupt has been configured to target secure state in target_cfg.c
 *
 * The SPU fault handler is just an extension to of the BusFault or SecureFault handler
 * that is triggered by events external to the CPU, such as an EasyDMA access.
 */

#if SPU_IRQn
#define EXCEPTION_TYPE_SPUFAULT (NVIC_USER_IRQ_OFFSET + SPU_IRQn)
#endif

#if SPU00_IRQn
#define EXCEPTION_TYPE_SPU00FAULT (NVIC_USER_IRQ_OFFSET + SPU00_IRQn)
#endif

#if SPU10_IRQn
#define EXCEPTION_TYPE_SPU10FAULT (NVIC_USER_IRQ_OFFSET + SPU10_IRQn)
#endif

#if SPU20_IRQn
#define EXCEPTION_TYPE_SPU20FAULT (NVIC_USER_IRQ_OFFSET + SPU20_IRQn)
#endif

#if SPU30_IRQn
#define EXCEPTION_TYPE_SPU30FAULT (NVIC_USER_IRQ_OFFSET + SPU30_IRQn)
#endif

typedef void (*ns_funcptr)(void) __attribute__((cmse_nonsecure_call));

static struct tfm_ns_fault_service_handler_context *ns_callback_context;
static ns_funcptr ns_callback;

int ns_fault_service_set_handler(struct tfm_ns_fault_service_handler_context *context,
				 tfm_ns_fault_service_handler_callback callback)
{
	ns_callback_context = context;
	ns_callback = (ns_funcptr)callback;

	return 0;
}

void call_ns_callback(struct exception_info_t *exc_info)
{
	struct nrf_exception_info spu_ctx;

	/* When an exception is triggered by the nonsecure the exception frame
	 * is stacked on the non-secure stack.
	 * If the non-secure stack is not pointing to valid memory for the
	 * nonsecure then a nested exception i.e HardFault is triggered.
	 * Since we don't provide the callback when a HardFault is triggered it
	 * is impossible that EXC_FRAME_COPY contains secure memory, and it is
	 * safe to copy this to non-secure.
	 */
	ns_callback_context->frame.r0 = exc_info->EXC_FRAME_COPY[0];
	ns_callback_context->frame.r1 = exc_info->EXC_FRAME_COPY[1];
	ns_callback_context->frame.r2 = exc_info->EXC_FRAME_COPY[2];
	ns_callback_context->frame.r3 = exc_info->EXC_FRAME_COPY[3];
	ns_callback_context->frame.r12 = exc_info->EXC_FRAME_COPY[4];
	ns_callback_context->frame.lr = exc_info->EXC_FRAME_COPY[5];
	ns_callback_context->frame.pc = exc_info->EXC_FRAME_COPY[6];
	ns_callback_context->frame.xpsr = exc_info->EXC_FRAME_COPY[7];

	ns_callback_context->registers.r4 = exc_info->CALLEE_SAVED_COPY[0];
	ns_callback_context->registers.r5 = exc_info->CALLEE_SAVED_COPY[1];
	ns_callback_context->registers.r6 = exc_info->CALLEE_SAVED_COPY[2];
	ns_callback_context->registers.r7 = exc_info->CALLEE_SAVED_COPY[3];
	ns_callback_context->registers.r8 = exc_info->CALLEE_SAVED_COPY[4];
	ns_callback_context->registers.r9 = exc_info->CALLEE_SAVED_COPY[5];
	ns_callback_context->registers.r10 = exc_info->CALLEE_SAVED_COPY[6];
	ns_callback_context->registers.r11 = exc_info->CALLEE_SAVED_COPY[7];

	ns_callback_context->status.cfsr = exc_info->CFSR;
	ns_callback_context->status.hfsr = exc_info->HFSR;
	ns_callback_context->status.sfsr = exc_info->SFSR;
	ns_callback_context->status.bfar = exc_info->BFAR;
	ns_callback_context->status.mmfar = exc_info->MMFAR;
	ns_callback_context->status.sfar = exc_info->SFAR;

	ns_callback_context->status.msp = __TZ_get_MSP_NS();
	ns_callback_context->status.psp = __TZ_get_PSP_NS();
	ns_callback_context->status.exc_return = exc_info->EXC_RETURN;
	ns_callback_context->status.control = __TZ_get_CONTROL_NS();
	ns_callback_context->status.vectactive = exc_info->VECTACTIVE;

	nrf_exception_info_get_context(&spu_ctx);
	ns_callback_context->status.spu_events = spu_ctx.events;

	ns_callback_context->valid = true;

	ns_callback();
}

void ns_fault_service_call_handler(void)
{
	struct exception_info_t exc_ctx;

	tfm_exception_info_get_context(&exc_ctx);

	const bool exc_ctx_valid = exc_ctx.EXC_RETURN != 0x0;

	if (!exc_ctx_valid || is_return_secure_stack(exc_ctx.EXC_RETURN)) {
		/* If exception is triggered by secure continue with secure
		 * fault handling.
		 */
		return;
	}

	switch (exc_ctx.VECTACTIVE) {
	case EXCEPTION_TYPE_SECUREFAULT:
	case EXCEPTION_TYPE_BUSFAULT:
#ifdef EXCEPTION_TYPE_SPUFAULT
	case EXCEPTION_TYPE_SPUFAULT:
#endif

#ifdef EXCEPTION_TYPE_SPU00FAULT
	case EXCEPTION_TYPE_SPU00FAULT:
#endif

#ifdef EXCEPTION_TYPE_SPU10FAULT
	case EXCEPTION_TYPE_SPU10FAULT:
#endif

#ifdef EXCEPTION_TYPE_SPU20FAULT
	case EXCEPTION_TYPE_SPU20FAULT:
#endif

#ifdef EXCEPTION_TYPE_SPU30FAULT
	case EXCEPTION_TYPE_SPU30FAULT:
#endif
		break;
	default:
		/* Always handle HardFaults in secure.
		 * UsageFault and MemManageFault are banked and they will be
		 * triggered in non-secure when fault originates in non-secure.
		 */
		return;
	}

	if (ns_callback) {
		call_ns_callback(&exc_ctx);
	}
	/* If no callback or the callback returns  we continue with the
	 * configured TF-M panic behavior.
	 */
}
