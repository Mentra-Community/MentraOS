#ifndef QJS_KT_JNI_GLOBALS_H
#define QJS_KT_JNI_GLOBALS_H

#include "jni.h"

void cache_java_vm(JNIEnv *env);

JNIEnv *get_jni_env();

void release_shared_jni_resources(JNIEnv *env);

#endif //QJS_KT_JNI_GLOBALS_H
