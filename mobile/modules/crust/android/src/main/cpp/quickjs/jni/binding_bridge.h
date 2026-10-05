#ifndef QJS_KT_JS_BINDING_BRIDGE_H
#define QJS_KT_JS_BINDING_BRIDGE_H

#include "jni.h"
#include "quickjs.h"
#include "cvector.h"
#include "quickjs_jni.h"

/**
 * Define a JavaScript object. It will be attached to the parent if the parent is not null,
 * otherwise, it will be attached to 'globalThis'.
 */
JSValue define_js_object(JNIEnv *env, JSContext *context,
                         Globals *globals,
                         jobject call_host,
                         JSValue *parent,
                         int64_t handle,
                         jstring name,
                         jobjectArray properties,
                         jobjectArray function_names);


/**
 * Define a JavaScript function. It will be attached to 'globalThis'.
 */
void define_js_function(JNIEnv *env, JSContext *context,
                        Globals *globals,
                        jobject call_host,
                        jstring name,
                        jboolean is_async);

#endif //QJS_KT_JS_BINDING_BRIDGE_H
