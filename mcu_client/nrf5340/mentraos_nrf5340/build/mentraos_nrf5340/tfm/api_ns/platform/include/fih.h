/*
 * Copyright (c) 2020-2022, Arm Limited. All rights reserved.
 * Copyright (c) 2024 Cypress Semiconductor Corporation (an Infineon
 * company) or an affiliate of Cypress Semiconductor Corporation. All rights
 * reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_FIH_H__
#define __TFM_FIH_H__

#include <stddef.h>
#include <stdint.h>

/*
 * Fault injection mitigation library.
 *
 * Has support for different measures, which can either be enabled/disabled
 * separately or by defining one of the TFM_FIH_PROFILEs.
 *
 * NOTE: It is not guaranteed that these constructs against fault injection
 *       attacks can be preserved in all compilers.
 *
 * FIH_ENABLE_DOUBLE_VARS makes critical variables into a tuple (x, x ^ msk).
 * Then the correctness of x can be checked by XORing the two tuple values
 * together. This also means that comparisons between fih_ints can be verified
 * by doing x == y && x_msk == y_msk.
 *
 * FIH_ENABLE_GLOBAL_FAIL makes all while(1) failure loops redirect to a global
 * failure loop. This loop has mitigations against loop escapes / unlooping.
 * This also means that any unlooping won't immediately continue executing the
 * function that was executing before the failure.
 *
 * FIH_ENABLE_CFI (Control Flow Integrity) creates a global counter that is
 * incremented before every FIH_CALL of vulnerable functions. On the function
 * return the counter is decremented, and after the return it is verified that
 * the counter has the same value as before this process. This can be used to
 * verify that the function has actually been called. This protection is
 * intended to discover that important functions are called in an expected
 * sequence and none of them is missed due to an instruction skip which could
 * be a result of glitching attack. It does not provide protection against ROP
 * or JOP attacks.
 *
 * FIH_ENABLE_DELAY causes random delays. This makes it hard to cause faults
 * precisely. It requires an RNG. A simple example using SysTick as entropy
 * source is provided in tfm_fih_rng.h, but any RNG that has an entropy
 * source can be used by implementing the fih_delay_random function.
 *
 * The basic call pattern is:
 *
 * fih_int fih_rc = FIH_FAILURE;
 * FIH_CALL(vulnerable_function, fih_rc, arg1, arg2);
 * if (fih_not_eq(fih_rc, FIH_SUCCESS)) {
 *     error_handling();
 * }
 *
 * If a fault injection is detected, call FIH_PANIC to trap the execution.
 *
 * Note that any function called by FIH_CALL must only return using FIH_RET,
 * as otherwise the CFI counter will not be decremented and the CFI check will
 * fail causing a panic.
 */

#ifdef __cplusplus
extern "C" {
#endif /* __cplusplus */

#undef FIH_ENABLE_GLOBAL_FAIL
#undef FIH_ENABLE_CFI
#undef FIH_ENABLE_DOUBLE_VARS
#undef FIH_ENABLE_DELAY

#ifdef TFM_FIH_PROFILE_ON
#if defined(TFM_FIH_PROFILE_LOW)
#define FIH_ENABLE_GLOBAL_FAIL
#define FIH_ENABLE_CFI

#elif defined(TFM_FIH_PROFILE_MEDIUM)
#define FIH_ENABLE_DOUBLE_VARS
#define FIH_ENABLE_GLOBAL_FAIL
#define FIH_ENABLE_CFI

#elif defined(TFM_FIH_PROFILE_HIGH)
#define FIH_ENABLE_DELAY         /* Requires an hardware entropy source */
#define FIH_ENABLE_DOUBLE_VARS
#define FIH_ENABLE_GLOBAL_FAIL
#define FIH_ENABLE_CFI

#else
#error "Invalid FIH Profile configuration"
#endif /* TFM_FIH_PROFILE */

#define FIH_TRUE              0xC35A
#define FIH_FALSE             0x0

#ifdef FIH_ENABLE_DOUBLE_VARS
#define FIH_POSITIVE_VALUE    0x5555AAAA
#define FIH_NEGATIVE_VALUE    0xAAAA5555

/*
 * A volatile mask is used to prevent compiler optimization - the mask is xored
 * with the variable to create the backup and the integrity can be checked with
 * another xor. The mask value doesn't _really_ matter that much, as long as
 * it has reasonably high hamming weight.
 */
#define _FIH_MASK_VALUE       0xA5C35A3C

/*
 * All ints are replaced with two int - the normal one and a backup which is
 * XORed with the mask.
 */
typedef struct {
    volatile int32_t val;
    volatile int32_t msk;
} fih_int;

#define FIH_INT_INIT(x)       {(x), (x) ^ _FIH_MASK_VALUE}
#else /* FIH_ENABLE_DOUBLE_VARS */
#define FIH_POSITIVE_VALUE    0x0
#define FIH_NEGATIVE_VALUE    0xAAAA5555

typedef volatile int32_t fih_int;

#define FIH_INT_INIT(x)       (x)
#endif /* FIH_ENABLE_DOUBLE_VARS */

extern fih_int FIH_SUCCESS;
extern fih_int FIH_FAILURE;

#ifdef FIH_ENABLE_GLOBAL_FAIL
/*
 * Global failure handler - more resistant to unlooping. noinline and used are
 * used to prevent optimization.
 *
 * NOTE
 * This failure handler shall be used as FIH specific error handling to capture
 * FI attacks. Error handling in SPM and SP should be enhanced respectively.
 */
__attribute__((noinline)) __attribute__((used)) void fih_panic_loop(void);
#define FIH_PANIC fih_panic_loop()
#else /* FIH_ENABLE_GLOBAL_FAIL */
#define FIH_PANIC  \
        do { \
            FIH_LABEL("FAILURE_LOOP"); \
            while (1) {} \
        } while (0)
#endif  /* FIH_ENABLE_GLOBAL_FAIL */

/*
 * NOTE
 * For functions to be inlined outside their compilation unit they have to
 * have the body in the header file. This is required as function calls are easy
 * to skip.
 */
#ifdef FIH_ENABLE_DELAY
/**
 * @brief Set up the RNG for use with random delays. Called once at startup.
 */
void fih_delay_init(void);

/**
 * Get a random uint8_t value from an RNG seeded with an entropy source.
 *
 * NOTE
 * Do not directly call this function.
 */
uint8_t fih_delay_random(void);

/* Delaying logic, with randomness from a CSPRNG */
__attribute__((always_inline)) inline
int fih_delay(void)
{
    uint32_t i = 0;
    volatile uint32_t delay = FIH_NEGATIVE_VALUE;
    volatile uint32_t counter = 0;

    delay = fih_delay_random();

    if (delay == FIH_NEGATIVE_VALUE) {
        FIH_PANIC;
    }

    delay &= 0xFF;

    for (i = 0; i < delay; i++) {
        counter++;
    }

    if (counter != delay) {
        FIH_PANIC;
    }

    return 1;
}
#else /* FIH_ENABLE_DELAY */
#define fih_delay_init()

#define fih_delay()     1
#endif /* FIH_ENABLE_DELAY */

#ifdef FIH_ENABLE_DOUBLE_VARS
__attribute__((always_inline)) inline
int fih_int_validate(fih_int x)
{
    if (x.val != (x.msk ^ _FIH_MASK_VALUE)) {
        FIH_PANIC;
    }

    return 1;
}

/* Convert a fih_int to an int. Validate for tampering. */
__attribute__((always_inline)) inline
int32_t fih_int_decode(fih_int x)
{
    (void)fih_int_validate(x);
    return x.val;
}

/* Convert an int to a fih_int, can be used to encode specific error codes. */
__attribute__((always_inline)) inline
fih_int fih_int_encode(int32_t x)
{
    fih_int ret = {x, x ^ _FIH_MASK_VALUE};
    return ret;
}

/* Standard equality. If A == B then 1, else 0 */
/* Note that this is designed to be difficult to glitch so as to make it
 * return 1 when it should return 0. It may not be as resistant the other
 * way.
 */
#define fih_eq(x, y)          \
    ( fih_int_validate(x) &&  \
      fih_int_validate(y) &&  \
      ((x).val == (y).val) && \
      fih_delay() &&          \
      ((x).msk == (y).msk) && \
      fih_delay() &&          \
      ((x).val == (_FIH_MASK_VALUE ^ (y).msk)) )

/* Note that this is designed to be difficult to glitch so as to make it
 * return 0 when it should return 1. It may not be as resistant the other
 * way.
 */
#define fih_not_eq(x, y)      \
    ( !fih_int_validate(x) || \
      !fih_int_validate(y) || \
      ((x).val != (y).val) || \
      !fih_delay() ||         \
      ((x).msk != (y).msk) || \
      !fih_delay() ||         \
      ((x).val != (_FIH_MASK_VALUE ^ (y).msk)) )
#else /* FIH_ENABLE_DOUBLE_VARS */
/* NOOP */
#define fih_int_validate(x)        1

/* NOOP */
#define fih_int_decode(x)          (x)

/* NOOP */
#define fih_int_encode(x)          (x)

#define fih_eq(x, y) \
    ( (x == y) &&    \
      fih_delay() && \
      !(x != y) )

#define fih_not_eq(x, y) \
    ( (x != y) ||        \
      !fih_delay() ||    \
      !(x == y) )
#endif /* FIH_ENABLE_DOUBLE_VARS */

/*
 * C has a common return pattern where 0 is a correct value and all others are
 * errors. This function converts 0 to FIH_SUCCESS and any other number to a
 * value that is not FIH_SUCCESS
 */
__attribute__((always_inline)) inline
fih_int fih_int_encode_zero_equality(int32_t x)
{
    if (x) {
        return FIH_FAILURE;
    } else {
        return FIH_SUCCESS;
    }
}

#ifdef FIH_ENABLE_CFI
/* Global Control Flow Integrity counter */
extern fih_int _fih_cfi_ctr;

/*
 * Increment the CFI counter by input counter and return the value before the
 * increment.
 *
 * NOTE
 * This function shall not be called directly.
 */
fih_int fih_cfi_get_and_increment(uint8_t cnt);

/*
 * Validate that the saved precall value is the same as the value of the global
 * counter. For this to be the case, a fih_ret must have been called between
 * these functions being executed. If the values aren't the same then panic.
 *
 * NOTE
 * This function shall not be called directly.
 */
void fih_cfi_validate(fih_int saved);

/*
 * Decrement the global CFI counter by one, so that it has the same value as
 * before the cfi_precall.
 *
 * NOTE
 * This function shall not be called directly.
 */
void fih_cfi_decrement(void);

/*
 * Macro wrappers for functions - Even when the functions have zero body this
 * saves a few bytes on noop functions as it doesn't generate the call/ret
 *
 * CFI precall function saves the CFI counter and then increments it - the
 * postcall then checks if the counter is equal to the saved value. In order for
 * this to be the case a FIH_RET must have been performed inside the called
 * function in order to decrement the counter, so the function must have been
 * called.
 */
#define FIH_CFI_PRECALL_BLOCK \
        fih_int _fih_cfi_precall_saved_value = fih_cfi_get_and_increment(1)

#define FIH_CFI_POSTCALL_BLOCK \
        fih_cfi_validate(_fih_cfi_precall_saved_value)

#define FIH_CFI_PRERET \
        fih_cfi_decrement()

/*
 * Marcos to support protect the control flow integrity inside a function.
 *
 * The FIH_CFI_PRECALL_BLOCK/FIH_CFI_POSTCALL_BLOCK pair mainly protect function
 * calls from fault injection. Fault injection may attack a function to skip its
 * critical steps which are not function calls. It is difficult for the caller
 * to dectect the injection as long as the function successfully returns.
 *
 * The following macros can be called in a function to track the critical steps,
 * especially those which are not function calls.
 */
/*
 * FIH_CFI_STEP_INIT() saves the CFI counter and increase the CFI counter by the
 * number of the critical steps. It should be called before execution starts.
 */
#define FIH_CFI_STEP_INIT(x) \
        fih_int _fih_cfi_step_saved_value = fih_cfi_get_and_increment(x)

/*
 * FIH_CFI_STEP_DECREMENT() decrease the CFI counter by one. It can be called
 * after each critical step execution completes.
 */
#define FIH_CFI_STEP_DECREMENT() \
        fih_cfi_decrement()

/*
 * FIH_CFI_STEP_ERR_RESET() resets the CFI counter to the previous value saved
 * by FIH_CFI_STEP_INIT(). It shall be called only when a functionality error
 * occurs and forces the function to exit. It can enable the caller to capture
 * the functionality error other than being trapped in fault injection error
 * handling.
 */
#define FIH_CFI_STEP_ERR_RESET() \
        do { \
            _fih_cfi_ctr = _fih_cfi_step_saved_value; \
            (void)fih_int_validate(_fih_cfi_ctr); \
        } while(0)

#else /* FIH_ENABLE_CFI */
#define FIH_CFI_PRECALL_BLOCK
#define FIH_CFI_POSTCALL_BLOCK
#define FIH_CFI_PRERET

#define FIH_CFI_STEP_INIT(x)
#define FIH_CFI_STEP_DECREMENT()
#define FIH_CFI_STEP_ERR_RESET()
#endif /* FIH_ENABLE_CFI */

/*
 * Label for interacting with FIH testing tool. Can be parsed from the elf file
 * after compilation. Does not require debug symbols.
 */
#define FIH_LABEL(str) __asm volatile ("FIH_LABEL_" str "_0_%=:" ::)
#define FIH_LABEL_CRITICAL_POINT() FIH_LABEL("FIH_CRITICAL_POINT")

/*
 * Main FIH calling macro. return variable is second argument. Does some setup
 * before and validation afterwards. Inserts labels for use with testing script.
 *
 * First perform the precall step - this gets the current value of the CFI
 * counter and saves it to a local variable, and then increments the counter.
 *
 * Then set the return variable to FIH_FAILURE as a base case.
 *
 * Then perform the function call. As part of the function FIH_RET must be
 * called which will decrement the counter.
 *
 * The postcall step gets the value of the counter and compares it to the
 * previously saved value. If this is equal then the function call and all child
 * function calls were performed.
 */
#define FIH_CALL(f, ret, ...) \
    do { \
        FIH_LABEL("FIH_CALL_START_" # f); \
        FIH_CFI_PRECALL_BLOCK; \
        ret = FIH_FAILURE; \
        (void)fih_delay(); \
        ret = f(__VA_ARGS__); \
        FIH_CFI_POSTCALL_BLOCK; \
        (void)fih_int_validate(ret); \
        FIH_LABEL("FIH_CALL_END"); \
    } while (0)

/*
 * FIH return changes the state of the internal state machine. If you do a
 * FIH_CALL then you need to do a FIH_RET else the state machine will detect
 * tampering and panic.
 */
#define FIH_RET(ret) \
    do { \
        FIH_CFI_PRERET; \
        return ret; \
    } while (0)

/*
 * FIH return type macro changes the function return types to fih_int.
 * All functions that need to be protected by FIH and called via FIH_CALL must
 * return a fih_int type.
 */
#define FIH_RET_TYPE(type)    fih_int

#else /* TFM_FIH_PROFILE_ON */
typedef int32_t fih_int;

#define FIH_INT_INIT(x)       (x)

#define FIH_SUCCESS           0
#define FIH_FAILURE           -1

#define fih_int_validate(x)   1

#define fih_int_decode(x)     (x)

#define fih_int_encode(x)     (x)

#define fih_int_encode_zero_equality(x) ((x) == 0 ? 0 : 1)

#define fih_eq(x, y)          ((x) == (y))

#define fih_not_eq(x, y)      ((x) != (y))

#define fih_delay_init()      (0)
#define fih_delay()           1

#define FIH_CALL(f, ret, ...) \
    do { \
        ret = f(__VA_ARGS__); \
    } while (0)

#define FIH_RET(ret) \
    do { \
        return ret; \
    } while (0)

#define FIH_RET_TYPE(type)    type

#define FIH_PANIC do { \
        while(1) {}; \
    } while (0)

#define FIH_CFI_STEP_INIT(x)
#define FIH_CFI_STEP_DECREMENT()
#define FIH_CFI_STEP_ERR_RESET()

#define FIH_LABEL_CRITICAL_POINT()

#endif /* TFM_FIH_PROFILE_ON */

#ifdef __cplusplus
}
#endif /* __cplusplus */

#endif /* __TFM_FIH_H__ */
