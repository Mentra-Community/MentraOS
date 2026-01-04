/*
 * app_cvt213x_log.h
 * Small shim to map CVT213X_APP_LOG_* macros to Zephyr logging APIs
 */

#ifndef _APP_CVT213X_LOG_H_
#define _APP_CVT213X_LOG_H_

#include <zephyr/logging/log.h>

/* If application logging is enabled, map the legacy macros to Zephyr LOG_*
 * macros. Do NOT automatically do a LOG_MODULE_DECLARE/REGISTER from this
 * header — that can cause symbol redefinition issues when a TU also registers
 * its own log module (e.g., shell modules). If you need to reference the
 * app_cvt213x module in a TU, define APP_CVT213X_DECLARE_LOG_MODULE before
 * including this header so that LOG_MODULE_DECLARE(app_cvt213x) is invoked.
 */
#ifdef CVT213X_APP_LOG_EN
#if CVT213X_APP_LOG_EN
#ifdef APP_CVT213X_DECLARE_LOG_MODULE
LOG_MODULE_DECLARE(app_cvt213x);
#endif
#ifndef CVT213X_APP_LOG_D
#define CVT213X_APP_LOG_D(level, fmt, ...) LOG_DBG(fmt, ##__VA_ARGS__)
#endif
#ifndef CVT213X_APP_LOG_E
#define CVT213X_APP_LOG_E(level, fmt, ...) LOG_ERR(fmt, ##__VA_ARGS__)
#endif
#ifndef CVT213X_APP_LOG_I
#define CVT213X_APP_LOG_I(level, fmt, ...) LOG_INF(fmt, ##__VA_ARGS__)
#endif
#ifndef CVT213X_APP_LOG_W
#define CVT213X_APP_LOG_W(level, fmt, ...) LOG_WRN(fmt, ##__VA_ARGS__)
#endif
#else
#ifndef CVT213X_APP_LOG_D
#define CVT213X_APP_LOG_D(level, fmt, ...)
#endif
#ifndef CVT213X_APP_LOG_E
#define CVT213X_APP_LOG_E(level, fmt, ...)
#endif
#ifndef CVT213X_APP_LOG_I
#define CVT213X_APP_LOG_I(level, fmt, ...)
#endif
#ifndef CVT213X_APP_LOG_W
#define CVT213X_APP_LOG_W(level, fmt, ...)
#endif
#endif
#else
#ifndef CVT213X_APP_LOG_D
#define CVT213X_APP_LOG_D(level, fmt, ...)
#endif
#ifndef CVT213X_APP_LOG_E
#define CVT213X_APP_LOG_E(level, fmt, ...)
#endif
#ifndef CVT213X_APP_LOG_I
#define CVT213X_APP_LOG_I(level, fmt, ...)
#endif
#ifndef CVT213X_APP_LOG_W
#define CVT213X_APP_LOG_W(level, fmt, ...)
#endif
#endif

#endif /* _APP_CVT213X_LOG_H_ */
