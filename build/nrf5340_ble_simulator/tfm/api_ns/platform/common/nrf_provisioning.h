/*
 * Copyright (c) 2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

/**
 * \brief Update the security lifecycle in OTP
 *
 * Check if this is valid transition according to the current state and update
 * the OTP to transition into the new state.
 *
 * \param slc Must be the same or the successor state of the current one.
 *
 * \retval 0 Update was successful.
 * \retval -EREADLCS    Error on reading the current state
 * \retval -EINVALIDLCS Invalid next state
 */
int tfm_attest_update_security_lifecycle_otp(enum tfm_security_lifecycle_t slc);
