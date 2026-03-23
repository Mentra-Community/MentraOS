/*
 * Copyright (c) 2021, Nordic Semiconductor ASA. All rights reserved.
 * Copyright (c) 2023, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#ifndef __EXCEPTION_INFO_H__
#define __EXCEPTION_INFO_H__

#include <stdint.h>

#if defined(__ARM_FEATURE_CMSE) && (__ARM_FEATURE_CMSE == 3U)
#define TRUSTZONE_PRESENT
#endif

#if defined(__ARM_ARCH_8_1M_MAIN__) || defined(__ARM_ARCH_8M_MAIN__) \
    || defined(__ARM_ARCH_7M__) || defined(__ARM_ARCH_7EM__)
#define FAULT_STATUS_PRESENT
#endif

/* Exception type number (subtract 16 for IRQn) */
#define EXCEPTION_TYPE_HARDFAULT      3
#define EXCEPTION_TYPE_MEMMANAGEFAULT 4
#define EXCEPTION_TYPE_BUSFAULT       5
#define EXCEPTION_TYPE_USAGEFAULT     6
#define EXCEPTION_TYPE_SECUREFAULT    7

/* Store context for an exception, and print an error message with the context.
 *
 * @param[in]  exception_type  One of the EXCEPTION_TYPE_* values defined above. Any
 *                             other value will result in printing "Unknown".
 */
#ifdef TFM_EXCEPTION_INFO_DUMP

struct exception_info_t {
    uint32_t VECTACTIVE;        /* Active exception number. */
    uint32_t EXC_RETURN;        /* EXC_RETURN value in LR. */
    uint32_t MSP;               /* (Secure) MSP. */
    uint32_t PSP;               /* (Secure) PSP. */
    uint32_t *EXC_FRAME;        /* Exception frame on stack. */
    uint32_t EXC_FRAME_COPY[8]; /* Copy of the basic exception frame. */
    uint32_t CALLEE_SAVED_COPY[8]; /* Copy of the callee saved registers. */
    uint32_t xPSR;              /* Program Status Registers. */

#ifdef FAULT_STATUS_PRESENT
    uint32_t CFSR;              /* Configurable Fault Status Register. */
    uint32_t HFSR;              /* Hard Fault Status Register. */
    uint32_t BFAR;              /* Bus Fault address register. */
    uint32_t BFARVALID;         /* Whether BFAR contains a valid address. */
    uint32_t MMFAR;             /* MemManage Fault address register. */
    uint32_t MMARVALID;         /* Whether MMFAR contains a valid address. */
#ifdef TRUSTZONE_PRESENT
    uint32_t SFSR;              /* SecureFault Status Register. */
    uint32_t SFAR;              /* SecureFault Address Register. */
    uint32_t SFARVALID;         /* Whether SFAR contains a valid address. */
#endif
#endif
};

/**
 * \brief Get a pointer to the current exception_info_t context
 *
 * \return  A pointer to the exception_info_t context or NULL if no context
 *          has been stored
 */
void tfm_exception_info_get_context(struct exception_info_t *ctx);

/* Store context for an exception, then print the info.
 * Call EXCEPTION_INFO() instead of calling this directly.
 */
void store_and_dump_context(uint32_t MSP_in, uint32_t PSP_in, uint32_t LR_in,
                            uint32_t *callee_saved);

/* IAR Specific */
#if defined(__ICCARM__)
#pragma required = store_and_dump_context
#endif

#if defined(__ARM_ARCH_8M_BASE__) || defined(__ARCM_ARCH_V6_M__)
#define EXCEPTION_INFO()                   \
    __ASM volatile(                        \
        "MRS    R0, MSP\n"                 \
        "MRS    R1, PSP\n"                 \
        "MOV    R2, R11\n"                 \
        "MOV    R3, R10\n"                 \
        "PUSH   {R2, R3}\n"                \
        "MOV    R2, R9\n"                  \
        "MOV    R3, R8\n"                  \
        "PUSH   {R2, R3}\n"                \
        "PUSH   {R4-R7}\n"                 \
        "MOV    R3, SP\n"                  \
        "MOV    R2, LR\n"                  \
        "BL     store_and_dump_context\n"  \
        "ADD    SP, #32\n"                 \
    )
#elif defined(__ARM_ARCH_8M_MAIN__) || defined(__ARM_ARCH_8_1M_MAIN__) || \
      defined(__ARM_ARCH_7M__) || defined(__ARM_ARCH_7EM__)
#define EXCEPTION_INFO()                   \
    __ASM volatile(                        \
        "MRS    R0, MSP\n"                 \
        "MRS    R1, PSP\n"                 \
        "PUSH   {R4-R11}\n"                \
        "MOV    R3, SP\n"                  \
        "MOV    R2, LR\n"                  \
        "BL     store_and_dump_context\n"  \
        "ADD    SP, #32\n"                 \
    )
#else
/* Unhandled arch, call store_and_dump_context with callee_saved = NULL */
#define EXCEPTION_INFO()                   \
    __ASM volatile(                        \
        "MRS    R0, MSP\n"                 \
        "MRS    R1, PSP\n"                 \
        "MOV    R2, LR\n"                  \
        "MOV    R3, #0\n"                  \
        "BL     store_and_dump_context\n"  \
    )
#endif

#else /* TFM_EXCEPTION_INFO_DUMP */
#define EXCEPTION_INFO()
#endif /* TFM_EXCEPTION_INFO_DUMP */

#endif /* __EXCEPTION_INFO_H__ */
