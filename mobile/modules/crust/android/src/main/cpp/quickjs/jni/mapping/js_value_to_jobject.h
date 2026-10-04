#ifndef QJS_KT_JS_VALUE_TO_JOBJECT_H
#define QJS_KT_JS_VALUE_TO_JOBJECT_H

#include "jni.h"
#include "quickjs.h"

/**
 * Convert js value to java object. Throw an exception if the value type is unsupported.
 */
jobject js_value_to_jobject(JNIEnv *env, JSContext *context, JSValue value);

#endif //QJS_KT_JS_VALUE_TO_JOBJECT_H
