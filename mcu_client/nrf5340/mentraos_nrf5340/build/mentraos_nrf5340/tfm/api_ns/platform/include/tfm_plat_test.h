/*
 * Copyright (c) 2019-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLAT_TEST_H__
#define __TFM_PLAT_TEST_H__

#include "tfm_plat_defs.h"

/**
 * \brief starts Secure timer
 *
 * Configures a timer to start counting, and generate a timer interrupt after a
 * certain amount of time. For the test case to be useful, the timeout value of
 * the timer should be long enough so that the test service can go to the state
 * where it starts waiting for the interrupt.
 */
#ifdef TFM_PARTITION_SLIH_TEST
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_SLIH_TEST", "APP-ROT")
#elif defined(TFM_PARTITION_FLIH_TEST)
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_FLIH_TEST", "APP-ROT")
#endif
void tfm_plat_test_secure_timer_start(void);


/**
 * \brief Clears Secure timer interrupt
 */
#ifdef TFM_PARTITION_SLIH_TEST
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_SLIH_TEST", "APP-ROT")
#elif TFM_PARTITION_FLIH_TEST
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_FLIH_TEST", "APP-ROT")
#endif
void tfm_plat_test_secure_timer_clear_intr(void);

/**
 * \brief Stops the Secure timer and clears the timer interrupt.
 */
#ifdef TFM_PARTITION_SLIH_TEST
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_SLIH_TEST", "APP-ROT")
#elif defined(TFM_PARTITION_FLIH_TEST)
TFM_LINK_SET_RO_IN_PARTITION_SECTION("TFM_SP_FLIH_TEST", "APP-ROT")
#endif
void tfm_plat_test_secure_timer_stop(void);

/**
 * \brief starts Non-secure timer
 *
 * Configures a timer to start counting, and generate a timer interrupt after a
 * certain amount of time. For the test case to be useful, the timeout value of
 * the timer should be long enough so that the test service can go to the state
 * where it starts waiting for the interrupt.
 */
void tfm_plat_test_non_secure_timer_start(void);

/**
 * \brief Stops the non-Secure timer and clears the timer interrupt.
 */
void tfm_plat_test_non_secure_timer_stop(void);


#endif /* __TFM_PLAT_TEST_H__ */
