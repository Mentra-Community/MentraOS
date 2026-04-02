/*
 * Copyright (c) 2024, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __FATAL_ERROR_H__
#define __FATAL_ERROR_H__

#include <stdint.h>
#include <stdbool.h>

#ifdef HALT_ON_FATAL_ERROR
#define ERROR_HALT() while(1);
#else
#define ERROR_HALT()
#endif /* HALT_ON_FATAL_ERROR */

#ifdef FATAL_ERR_LOG_FILE_AND_LINE
#define ERR_FILE __FILE__
#define ERR_LINE __LINE__
#else
#define ERR_FILE NULL
#define ERR_LINE 0
#endif /* FATAL_ERR_LOG_FILE_AND_LINE */


bool log_error_permissions_check(uint32_t err, bool is_fatal);
void log_error(char *file, uint32_t line, uint32_t err, void *sp, bool is_fatal);

#ifdef LOG_FATAL_ERRORS
#define FATAL_ERR(x) do { \
    uint32_t foo; \
    if (log_error_permissions_check(x, true)) { \
        log_error(ERR_FILE, ERR_LINE, x, &foo, true); \
    } \
    ERROR_HALT(); \
} while(0);
#else
#define FATAL_ERR(x) ERROR_HALT();
#endif /* LOG_FATAL_ERRORS */

#ifdef LOG_NONFATAL_ERRORS
#define NONFATAL_ERR(x) do { \
    uint32_t foo; \
    if (log_error_permissions_check(x, false)) { \
        log_error(ERR_FILE, ERR_LINE, x, &foo, false); \
    } \
} while(0);
#else
#define NONFATAL_ERR(x)
#endif /* LOG_NONFATAL_ERRORS */

#endif /* __FATAL_ERROR_H__ */
