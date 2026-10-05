#ifndef QJS_KT_LOG_UTIL_H
#define QJS_KT_LOG_UTIL_H

#ifdef CONFIG_ANDROID

#include <android/log.h>

#define log(fmt, ...) __android_log_print(ANDROID_LOG_DEBUG, "QuickJSJni", fmt, ##__VA_ARGS__)
#else
#include <stdio.h>

#define log(fmt, ...) printf(fmt, ##__VA_ARGS__); printf("\n")
#endif

#endif //QJS_KT_LOG_UTIL_H
