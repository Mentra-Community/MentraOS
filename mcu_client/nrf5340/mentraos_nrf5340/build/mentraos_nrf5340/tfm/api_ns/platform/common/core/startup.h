/*
 * Copyright (c) 2023 Nordic Semiconductor ASA
 * Copyright (c) 2024, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

/*
 * This file has declarations needed by startup.c and
 * startup_<platform>.c.
 */

#ifndef __STARTUP_H__
#define __STARTUP_H__

extern uint32_t __INITIAL_SP;
extern uint32_t __STACK_LIMIT;

#if defined (__ARM_FEATURE_CMSE) && (__ARM_FEATURE_CMSE == 3U)
extern uint64_t __STACK_SEAL;
#endif

typedef void(*VECTOR_TABLE_Type)(void);

__NO_RETURN void __PROGRAM_START(void);

#define DEFAULT_IRQ_HANDLER(handler_name)  \
__NO_RETURN void __attribute__((weak, alias("default_tfm_IRQHandler"))) handler_name(void);

__NO_RETURN void Reset_Handler(void);
__NO_RETURN void HardFault_Handler(void);
__NO_RETURN void MemManage_Handler(void);
__NO_RETURN void BusFault_Handler(void);
__NO_RETURN void UsageFault_Handler(void);
__NO_RETURN void SecureFault_Handler(void);

void SPU_IRQHandler(void);

void SPU00_IRQHandler(void);
void SPU10_IRQHandler(void);
void SPU20_IRQHandler(void);
void SPU30_IRQHandler(void);

void MPC00_IRQHandler(void);

void CRACEN_IRQHandler(void);

/*
 * The default irq handler is used as a backup in case of
 * misconfiguration.
 */
void default_irq_handler(void);

extern const VECTOR_TABLE_Type __VECTOR_TABLE[];

#endif /* __STARTUP_H__ */
