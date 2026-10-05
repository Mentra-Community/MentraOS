#include <stdlib.h>
#include <string.h>
#include "exception_util.h"
#include "jni_globals_generated.h"
#include "log_util.h"
#include "js_value_util.h"

jthrowable new_qjs_exception(JNIEnv *env, const char *format, ...) {
    va_list args;
    va_start(args, format);
    int length = vsnprintf(NULL, 0, format, args);
    va_end(args);

    char *result = (char *) malloc(length + 1);

    va_start(args, format);
    vsnprintf(result, length + 1, format, args);
    va_end(args);

    jstring message = (*env)->NewStringUTF(env, result);
    return (*env)->NewObject(env, cls_quick_js_exception(env),
                             method_quick_js_exception_init(env), message);
}

void jni_throw_qjs_exception(JNIEnv *env, const char *format, ...) {
    va_list args;
    va_start(args, format);
    int length = vsnprintf(NULL, 0, format, args);
    va_end(args);

    char *result = (char *) malloc(length + 1);

    va_start(args, format);
    vsnprintf(result, length + 1, format, args);
    va_end(args);

    (*env)->ThrowNew(env, cls_quick_js_exception(env), result);
}

jthrowable try_catch_java_exceptions(JNIEnv *env) {
    jthrowable exception = (*env)->ExceptionOccurred(env);
    if (exception != NULL) {
        (*env)->ExceptionClear(env);
        return exception;
    } else {
        return NULL;
    }
}

int check_js_context_exception(JNIEnv *env, JSContext *context) {
    JSValue exception = JS_GetException(context);
    // Check exception
    if (!JS_IsNull(exception)) {
        char *message = NULL;
        js_error_to_string(context, exception, &message);
        // Free values
        JS_FreeValue(context, exception);
        // Throw java exception
        jni_throw_qjs_exception(env, message);
        return 1;
    } else {
        return 0;
    }
}