#ifndef QJS_KT_JNI_H
#define QJS_KT_JNI_H

#include <pthread.h>
#include "cvector.h"
#include "quickjs.h"
#include "jni.h"

/**
 * Global objects for the wrapped runtime.
 */
typedef struct {
    /**
     * Some JS values, used by C functions.
     */
    cvector_vector_type(JSValue)managed_js_values;
    /**
     * Defined JS objects, keep them to support nested define.
     */
    cvector_vector_type(JSValue)defined_js_objects;
    /**
     * Promise resolve/reject functions.
     */
    cvector_vector_type(JSValue)created_js_functions;
    /**
     * Global JNI refs.
     */
    cvector_vector_type(jobject)global_object_refs;
    /**
     * Result promises of eval calls.
     */
    JSValue *evaluate_result_promise;
    /**
     * The mutex which is used to protect the JS stack in a multi-threaded environment.
     * Scopes with a JS_UpdateStackTop() call are required to be locked.
     */
    pthread_mutex_t js_mutex;
} Globals;

#endif //QJS_KT_JNI_H
