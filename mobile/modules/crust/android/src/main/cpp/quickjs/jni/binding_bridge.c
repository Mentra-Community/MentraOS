#include "binding_bridge.h"
#include "exception_util.h"
#include "jni_globals.h"
#include "jni_globals_generated.h"
#include "log_util.h"
#include "js_value_to_jobject.h"
#include "jobject_to_js_value.h"
#include "js_value_util.h"
#include "jni_types_util.h"

#define COMMON_FUNC_DATA_LEN 2

#define GLOBAL_THIS_HANDLE -1

void set_eval_exception_to_caller(JNIEnv *env, jobject call_host, jthrowable exception) {
    jmethodID set_exception_method = method_quick_js_set_eval_exception(env);
    (*env)->CallVoidMethod(env, call_host, set_exception_method, exception);
}

JSValue jni_invoke_getter(JSContext *context, jobject call_host, int64_t object_handle,
                          const char *property_name) {
    JNIEnv *env = get_jni_env();
    if (env == NULL) {
        return JS_EXCEPTION;
    }
    // Don't release
    jstring java_name = (*env)->NewStringUTF(env, property_name);
    jobject result = (*env)->CallObjectMethod(env, call_host,
                                              method_quick_js_on_call_getter(env),
                                              object_handle, java_name);
    (*env)->DeleteLocalRef(env, java_name);
    // Check java exceptions
    jthrowable exception = try_catch_java_exceptions(env);
    if (exception != NULL) {
        set_eval_exception_to_caller(env, call_host, exception);
        (*env)->DeleteLocalRef(env, exception);
        return JS_EXCEPTION;
    }
    if (result == NULL) {
        return JS_NULL;
    }
    return jobject_to_js_value(env, context, NULL, result);
}

JSValue jni_invoke_setter(JSContext *context, jobject call_host, int64_t object_handle,
                          const char *property_name, int argc, JSValueConst *argv) {
    JNIEnv *env = get_jni_env();
    if (env == NULL) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_EXCEPTION;
    }
    jobject value = js_value_to_jobject(env, context, argv[0]);
    // Check mapping exceptions
    jthrowable mapping_exception = try_catch_java_exceptions(env);
    if (mapping_exception != NULL) {
        set_eval_exception_to_caller(env, call_host, mapping_exception);
        (*env)->DeleteLocalRef(env, value);
        (*env)->DeleteLocalRef(env, mapping_exception);
        return JS_EXCEPTION;
    }
    // Don't release
    jstring java_name = (*env)->NewStringUTF(env, property_name);
    (*env)->CallVoidMethod(env, call_host, method_quick_js_on_call_setter(env),
                           object_handle, java_name, value);
    (*env)->DeleteLocalRef(env, java_name);
    // Check java exceptions
    jthrowable exception = try_catch_java_exceptions(env);
    if (exception != NULL) {
        set_eval_exception_to_caller(env, call_host, exception);
        (*env)->DeleteLocalRef(env, exception);
        return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

JSValue jni_invoke_function(JSContext *context, jobject call_host, int64_t object_handle,
                            const char *function_name, int argc, JSValueConst *argv) {
    JNIEnv *env = get_jni_env();
    if (env == NULL) {
        return JS_EXCEPTION;
    }
    jobjectArray args = (*env)->NewObjectArray(env, argc, cls_object(env), NULL);
    for (uint32_t i = 0; i < argc; i++) {
        jobject arg = js_value_to_jobject(env, context, argv[i]);
        // Check mapping exceptions
        jthrowable exception = try_catch_java_exceptions(env);
        if (exception != NULL) {
            set_eval_exception_to_caller(env, call_host, exception);
            (*env)->DeleteLocalRef(env, arg);
            (*env)->DeleteLocalRef(env, exception);
            return JS_EXCEPTION;
        }
        (*env)->SetObjectArrayElement(env, args, i, arg);
        (*env)->DeleteLocalRef(env, arg);
    }
    // Don't release
    jstring java_name = (*env)->NewStringUTF(env, function_name);
    jobject result = (*env)->CallObjectMethod(env, call_host,
                                              method_quick_js_on_call_function(env),
                                              object_handle,
                                              java_name,
                                              args);
    (*env)->DeleteLocalRef(env, java_name);
    // Check java exceptions
    jthrowable exception = try_catch_java_exceptions(env);
    if (exception != NULL) {
        set_eval_exception_to_caller(env, call_host, exception);
        (*env)->DeleteLocalRef(env, exception);
        return JS_EXCEPTION;
    }
    return jobject_to_js_value(env, context, NULL, result);
}

JSValue jni_invoke_async_function(JSContext *context, jobject call_host,
                                  int64_t object_handle,
                                  const char *function_name,
                                  uint64_t resolve_handle,
                                  uint64_t reject_handle,
                                  int argc, JSValueConst *argv) {
    JNIEnv *env = get_jni_env();
    if (env == NULL) {
        return JS_EXCEPTION;
    }
    int args_len = argc + 2;
    jobjectArray args = (*env)->NewObjectArray(env, args_len, cls_object(env), NULL);
    // Set promise handles
    (*env)->SetObjectArrayElement(env, args, 0, java_boxed_long(env, resolve_handle));
    (*env)->SetObjectArrayElement(env, args, 1, java_boxed_long(env, reject_handle));
    // Fill args
    for (uint32_t i = 0; i < argc; i++) {
        jobject arg = js_value_to_jobject(env, context, argv[i]);
        // Check mapping exceptions
        jthrowable exception = try_catch_java_exceptions(env);
        if (exception != NULL) {
            set_eval_exception_to_caller(env, call_host, exception);
            (*env)->DeleteLocalRef(env, arg);
            (*env)->DeleteLocalRef(env, exception);
            return JS_EXCEPTION;
        }
        (*env)->SetObjectArrayElement(env, args, i + (args_len - argc), arg);
        (*env)->DeleteLocalRef(env, arg);
    }
    // Don't release
    jstring java_name = (*env)->NewStringUTF(env, function_name);
    (*env)->CallObjectMethod(env, call_host,
                             method_quick_js_on_call_function(env),
                             object_handle,
                             java_name,
                             args);
    (*env)->DeleteLocalRef(env, java_name);
    // Check java exceptions
    jthrowable exception = try_catch_java_exceptions(env);
    if (exception != NULL) {
        set_eval_exception_to_caller(env, call_host, exception);
        (*env)->DeleteLocalRef(env, exception);
        return JS_EXCEPTION;
    }
    // No return value needs to handle
    return JS_UNDEFINED;
}

JSValue
property_getter(JSContext *context, JSValueConst this_val, int argc, JSValueConst *argv, int magic,
                JSValue *func_data) {
    int64_t host_address;
    JS_ToInt64(context, &host_address, func_data[0]);
    jobject call_host = (jobject) host_address;
    int64_t object_handle;
    JS_ToInt64(context, &object_handle, func_data[1]);
    const char *prop_name = JS_ToCString(context, func_data[2]);

    JSValue result = jni_invoke_getter(context, call_host, object_handle, prop_name);

    JS_FreeCString(context, prop_name);

    return result;
}

JSValue
property_setter(JSContext *context, JSValueConst this_val, int argc, JSValueConst *argv, int magic,
                JSValue *func_data) {
    int64_t host_address;
    JS_ToInt64(context, &host_address, func_data[0]);
    jobject call_host = (jobject) host_address;
    int64_t object_handle;
    JS_ToInt64(context, &object_handle, func_data[1]);
    const char *prop_name = JS_ToCString(context, func_data[2]);

    JSValue result = jni_invoke_setter(context, call_host, object_handle, prop_name, argc, argv);

    JS_FreeCString(context, prop_name);

    return result;
}

JSValue
function_invoke(JSContext *context, JSValueConst this_val, int argc, JSValueConst *argv, int magic,
                JSValue *func_data) {
    int64_t host_address;
    JS_ToInt64(context, &host_address, func_data[0]);
    jobject call_host = (jobject) host_address;
    int64_t object_handle;
    JS_ToInt64(context, &object_handle, func_data[1]);
    const char *func_name = JS_ToCString(context, func_data[2]);

    JSValue result = jni_invoke_function(context, call_host, object_handle, func_name, argc, argv);

    JS_FreeCString(context, func_name);

    return result;
}

JSValue async_function_invoke(JSContext *context, JSValueConst this_val,
                              int argc, JSValueConst *argv, int magic,
                              JSValue *func_data) {
    JNIEnv *env = get_jni_env();
    if (env == NULL) {
        return JS_EXCEPTION;
    }

    // Get the jni host
    int64_t host_address;
    JS_ToInt64(context, &host_address, func_data[0]);
    jobject call_host = (jobject) host_address;

    // Get the parent handle
    int64_t object_handle;
    JS_ToInt64(context, &object_handle, func_data[1]);

    // Get the function name
    const char *function_name = JS_ToCString(context, func_data[2]);

    // Get globals
    int64_t globals_address_low;
    int64_t globals_address_high;
    JS_ToInt64(context, &globals_address_low, func_data[3]);
    JS_ToInt64(context, &globals_address_high, func_data[4]);
    int64_t globals_address = (globals_address_low & 0xFFFFFFFF) | globals_address_high << 32;
    Globals *globals = (Globals *) globals_address;

    // Handles are the indices
    int64_t resolve_handle = cvector_size(globals->created_js_functions);
    int64_t reject_handle = resolve_handle + 1;

    JSValue promise_functions[2];
    JSValue promise = JS_NewPromiseCapability(context, promise_functions);

    cvector_push_back(globals->managed_js_values, promise);
    cvector_push_back(globals->created_js_functions, promise_functions[0]);
    cvector_push_back(globals->created_js_functions, promise_functions[1]);

    // Call java function
    JSValue result = jni_invoke_async_function(context, call_host, object_handle,
                                               function_name, resolve_handle, reject_handle,
                                               argc, argv);

    JS_FreeCString(context, function_name);

    if (JS_IsException(result)) {
        // Error!
        return result;
    } else {
        // Ignore the async return
        JS_FreeValue(context, result);
    }

    // Return the promise directly will cause a GC error:
    // void gc_decref_child(JSRuntime *, JSGCObjectHeader *): assertion "p->ref_count > 0" failed
    return JS_DupValue(context, promise);
}

void define_async_js_function_on(JSContext *context,
                                 Globals *globals,
                                 JSValue parent,
                                 const char *name,
                                 int func_data_len,
                                 JSValue *func_data) {
    // Append the globals pointer to the function data
    size_t async_func_data_len = func_data_len + 2;
    JSValue async_func_data[async_func_data_len];
    for (int i = 0; i < func_data_len; ++i) {
        async_func_data[i] = func_data[i];
    }
    int64_t globals_address = (int64_t) (globals);
    int64_t globals_low = globals_address & 0xFFFFFFFF;
    int64_t globals_high = (globals_address >> 32) & 0xFFFFFFFF;
    async_func_data[func_data_len] = JS_NewInt64(context, globals_low);
    async_func_data[func_data_len + 1] = JS_NewInt64(context, globals_high);

    for (int i = func_data_len; i < async_func_data_len; ++i) {
        // Add to free
        cvector_push_back(globals->managed_js_values, async_func_data[i]);
    }

    JSValue invoke = JS_NewCFunctionData(context, async_function_invoke, 0, 0,
                                         async_func_data_len,
                                         async_func_data);
    int flags = JS_PROP_CONFIGURABLE;
    JSAtom prop = JS_NewAtom(context, name);
    // Define async function
    JS_DefinePropertyValue(context, parent, prop, invoke, flags);
    JS_FreeAtom(context, prop);
}

void define_js_function_on(JSContext *context,
                           JSValue parent,
                           const char *name,
                           int func_data_len,
                           JSValue *func_data) {
    JSValue invoke = JS_NewCFunctionData(context, function_invoke, 0, 0, func_data_len, func_data);
    int flags = JS_PROP_CONFIGURABLE;
    JSAtom prop = JS_NewAtom(context, name);
    // Define function
    JS_DefinePropertyValue(context, parent, prop, invoke, flags);
    JS_FreeAtom(context, prop);
}

void define_js_functions_on(JNIEnv *env,
                            JSContext *context,
                            Globals *globals,
                            JSValue parent,
                            jobjectArray functions,
                            JSValue *common_func_data) {
    jsize func_size = (*env)->GetArrayLength(env, functions);

    jfieldID field_name = field_js_function_name(env);
    jfieldID field_is_async = field_js_function_is_async(env);

    // Add functions
    for (jsize i = 0; i < func_size; i++) {
        jobject j_fun = (*env)->GetObjectArrayElement(env, functions, i);
        jstring j_fun_name = (*env)->GetObjectField(env, j_fun, field_name);
        const char *func_name = (*env)->GetStringUTFChars(env, j_fun_name, NULL);
        jboolean is_async = (*env)->GetBooleanField(env, j_fun, field_is_async);

        // Function data
        uint32_t data_len = COMMON_FUNC_DATA_LEN + 1;
        JSValue func_data[data_len];
        for (int j = 0; j < data_len - 1; j++) {
            func_data[j] = common_func_data[j];
        }
        JSValue js_func_name = JS_NewString(context, func_name);
        cvector_push_back(globals->managed_js_values, js_func_name);
        func_data[data_len - 1] = js_func_name;

        if (is_async) {
            define_async_js_function_on(context, globals, parent, func_name, data_len, func_data);
        } else {
            define_js_function_on(context, parent, func_name, data_len, func_data);
        }

        (*env)->ReleaseStringUTFChars(env, j_fun_name, func_name);
        (*env)->DeleteLocalRef(env, j_fun_name);
    }
}

JSValue define_js_object(JNIEnv *env, JSContext *context,
                         Globals *globals,
                         jobject host,
                         JSValue *parent,
                         int64_t handle,
                         jstring name,
                         jobjectArray properties,
                         jobjectArray functions) {
    jobject global_host = (*env)->NewGlobalRef(env, host);
    cvector_push_back(globals->global_object_refs, global_host);

    jsize prop_size = (*env)->GetArrayLength(env, properties);

    JSValue common_func_data[COMMON_FUNC_DATA_LEN] = {
            JS_NewInt64(context, (int64_t) global_host), // host address
            JS_NewInt64(context, handle), // object handle
    };

    // Free these values before freeing the runtime
    for (uint32_t i = 0; i < COMMON_FUNC_DATA_LEN; i++) {
        cvector_push_back(globals->managed_js_values, common_func_data[i]);
    }

    JSValue object = JS_NewObject(context);

    // Add properties
    for (jsize i = 0; i < prop_size; i++) {
        jobject element = (*env)->GetObjectArrayElement(env, properties, i);

        jstring j_prop_name = (*env)->GetObjectField(env, element, field_js_property_name(env));
        const char *prop_name = (*env)->GetStringUTFChars(env, j_prop_name, NULL);
        jboolean configurable = (*env)->GetBooleanField(env, element,
                                                        field_js_property_configurable(env));
        jboolean writable = (*env)->GetBooleanField(env, element, field_js_property_writable(env));
        jboolean enumerable = (*env)->GetBooleanField(env, element,
                                                      field_js_property_enumerable(env));

        // Function data
        uint32_t data_len = COMMON_FUNC_DATA_LEN + 1;
        JSValue func_data[data_len];
        for (int j = 0; j < data_len - 1; j++) {
            func_data[j] = common_func_data[j];
        }
        JSValue js_prop_name = JS_NewString(context, prop_name);
        cvector_push_back(globals->managed_js_values, js_prop_name);
        func_data[data_len - 1] = js_prop_name;

        JSValue getter = JS_NewCFunctionData(context, property_getter, 0, 0, data_len, func_data);
        int flags = JS_PROP_C_W_E;
        if (configurable == JNI_FALSE) {
            flags = flags & ~JS_PROP_CONFIGURABLE;
        }
        if (writable == JNI_FALSE) {
            flags = flags & ~JS_PROP_WRITABLE;
        }
        if (enumerable == JNI_FALSE) {
            flags = flags & ~JS_PROP_ENUMERABLE;
        }

        JSAtom prop = JS_NewAtom(context, prop_name);

        // Define property
        if (writable == JNI_FALSE) {
            JS_DefinePropertyGetSet(context, object, prop, getter, JS_UNDEFINED, 0);
        } else {
            JSValue setter = JS_NewCFunctionData(context, property_setter, 0, 0, data_len,
                                                 func_data);
            JS_DefinePropertyGetSet(context, object, prop, getter, setter, flags);
        }

        JS_FreeAtom(context, prop);

        (*env)->ReleaseStringUTFChars(env, j_prop_name, prop_name);
        (*env)->DeleteLocalRef(env, j_prop_name);
        (*env)->DeleteLocalRef(env, element);
    }

    // Add functions
    define_js_functions_on(env, context, globals, object, functions, common_func_data);

    const char *c_name = (*env)->GetStringUTFChars(env, name, NULL);

    if (parent == NULL) {
        JSValue global_this = JS_GetGlobalObject(context);
        // Attach object to globalThis
        JS_DefinePropertyValueStr(context, global_this, c_name, object, 0);
        JS_FreeValue(context, global_this);
    } else {
        // Attach object to parent
        JS_DefinePropertyValueStr(context, *parent, c_name, object, 0);
    }

    (*env)->ReleaseStringUTFChars(env, name, c_name);

    return object;
}

void define_js_function(JNIEnv *env, JSContext *context,
                        Globals *globals,
                        jobject host,
                        jstring name,
                        jboolean is_async) {
    jobject global_host = (*env)->NewGlobalRef(env, host);
    cvector_push_back(globals->global_object_refs, global_host);

    const char *func_name = (*env)->GetStringUTFChars(env, name, NULL);

    // Function data
    uint32_t data_len = COMMON_FUNC_DATA_LEN + 1;
    JSValue func_data[3] = {
            JS_NewInt64(context, (int64_t) global_host), // host address
            JS_NewInt64(context, GLOBAL_THIS_HANDLE), // parent object handle
            JS_NewString(context, func_name), // function name
    };

    for (uint32_t i = 0; i < data_len; i++) {
        cvector_push_back(globals->managed_js_values, func_data[i]);
    }

    JSValue global_this = JS_GetGlobalObject(context);
    if (is_async) {
        define_async_js_function_on(context, globals, global_this, func_name,
                                    data_len, func_data);
    } else {
        define_js_function_on(context, global_this, func_name, data_len, func_data);
    }
    JS_FreeValue(context, global_this);

    (*env)->ReleaseStringUTFChars(env, name, func_name);
}
