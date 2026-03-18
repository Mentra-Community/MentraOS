/*
 * Copyright (c) 2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include <stdarg.h>
#include <stddef.h>

/* This function is here in case any references to printf has been accidentally
 * left in the code. This will then mute this printfs from pulling in the real
 * printf instead of the function defined in tfm_sp_log_raw.c when this file
 * is not part of the build.
 */
int printf(const char *fmt, ...)
{
	return 0;
}
