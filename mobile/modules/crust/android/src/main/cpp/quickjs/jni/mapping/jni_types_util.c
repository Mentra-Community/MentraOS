#include "jni_types_util.h"
#include "jni_globals_generated.h"

jobject java_boxed_boolean(JNIEnv *env, jboolean value) {
    jclass cls = cls_boolean(env);
    jmethodID method = method_boolean_value_of(env);
    return (*env)->CallStaticObjectMethod(env, cls, method, value);
}

jobject java_boxed_long(JNIEnv *env, int64_t value) {
    jclass cls = cls_long(env);
    jmethodID method = method_long_value_of(env);
    return (*env)->CallStaticObjectMethod(env, cls, method, value);
}

jobject java_boxed_double(JNIEnv *env, jdouble value) {
    jclass cls = cls_double(env);
    jmethodID method = method_double_value_of(env);
    return (*env)->CallStaticObjectMethod(env, cls, method, value);
}

jobject java_boxed_nan_double(JNIEnv *env) {
    jclass cls = cls_double(env);
    jfieldID field = field_double_na_n(env);
    jdouble basic = (*env)->GetStaticDoubleField(env, cls, field);
    return java_boxed_double(env, basic);
}
