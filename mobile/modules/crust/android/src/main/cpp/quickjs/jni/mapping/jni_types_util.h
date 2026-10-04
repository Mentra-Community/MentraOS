#ifndef QJS_KT_JNI_TYPES_UTIL_H
#define QJS_KT_JNI_TYPES_UTIL_H

#include <stdint.h>
#include "jni.h"

jobject java_boxed_boolean(JNIEnv *env, jboolean value);

jobject java_boxed_long(JNIEnv *env, int64_t value);

jobject java_boxed_double(JNIEnv *env, jdouble value);

jobject java_boxed_nan_double(JNIEnv *env);

#endif //QJS_KT_JNI_TYPES_UTIL_H
