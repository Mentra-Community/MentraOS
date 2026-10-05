#include <string.h>
#include <stdlib.h>
#include "js_value_to_jobject.h"
#include "js_value_util.h"
#include "jni_globals_generated.h"
#include "exception_util.h"
#include "log_util.h"
#include "jni_types_util.h"

jobject to_java_string(JNIEnv *env, const char *str) {
    return str != NULL ? (*env)->NewStringUTF(env, str) : NULL;
}

void replace_dots_with_slashes(char *str) {
    if (str == NULL) {
        return;
    }
    size_t len = strlen(str);
    for (int i = 0; i < len; ++i) {
        if (str[i] == '.') {
            str[i] = '/';
        }
    }
}

jthrowable js_error_to_java_error(JNIEnv *env, JSContext *context, JSValue error) {
    // Get name
    JSValue js_name = JS_GetPropertyStr(context, error, "name");

    if (JS_IsUndefined(js_name)) {
        // Could be arbitrary types
        const char *c_str = JS_ToCString(context, error);
        const char *str = c_str != NULL ? c_str : "<UNSUPPORTED_ERROR>";
        if (c_str != NULL) {
            JS_FreeCString(context, c_str);
        }
        jthrowable java_error = new_qjs_exception(env, str);
        JS_FreeValue(context, js_name);
        return java_error;
    }

    const char *original_name = JS_ToCString(context, js_name);
    const char *name = original_name != NULL ? original_name : "<UNKNOWN_ERROR>";

    jclass java_error_cls = NULL;
    if (original_name != NULL) {
        char *maybe_cls_name = malloc(strlen(original_name) + 1);
        strcpy(maybe_cls_name, original_name);
        replace_dots_with_slashes(maybe_cls_name);
        java_error_cls = (*env)->FindClass(env, maybe_cls_name);
        jthrowable exception = try_catch_java_exceptions(env);
        if (exception != NULL) {
            java_error_cls = NULL;
        }
        free(maybe_cls_name);
    }

    // Get message
    JSValue js_message = JS_GetPropertyStr(context, error, "message");
    const char *original_message = JS_ToCString(context, js_message);
    const char *message = original_message != NULL ? original_message : "<NO_MESSAGE>";

    int name_len = strlen(name);
    int msg_len = strlen(message);

    // Get stack trace
    JSValue stack = JS_GetPropertyStr(context, error, "stack");

    char *full_message;
    if (!JS_IsUndefined(stack)) {
        char *joined = js_array_join(context, stack, "\n");
        const char *stack_str = joined != NULL ? joined : JS_ToCString(context, stack);

        // Join
        if (java_error_cls == NULL) {
            // Add error name to the message
            full_message = (char *) malloc(name_len + msg_len + strlen(stack_str) + 4);
            sprintf(full_message, "%s: %s\n%s", name, message, stack_str);
        } else {
            full_message = (char *) malloc(msg_len + strlen(stack_str) + 2);
            sprintf(full_message, "%s\n%s", message, stack_str);
        }
        // Free
        if (joined != NULL) {
            free((void *) stack_str);
        } else {
            JS_FreeCString(context, stack_str);
        }
    } else {
        if (java_error_cls == NULL) {
            full_message = malloc(name_len + msg_len + 3);
            sprintf(full_message, "%s: %s", name, message);
        } else {
            full_message = malloc(msg_len + 1);
            strcpy(full_message, message);
        }
    }

    if (original_name != NULL) {
        JS_FreeCString(context, original_name);
    }
    if (original_message != NULL) {
        JS_FreeCString(context, original_message);
    }
    JS_FreeValue(context, js_name);
    JS_FreeValue(context, js_message);
    JS_FreeValue(context, stack);

    if (java_error_cls != NULL) {
        jmethodID constructor = (*env)->GetMethodID(env, java_error_cls, "<init>",
                                                    "(Ljava/lang/String;)V");
        jthrowable e = try_catch_java_exceptions(env);
        if (e == NULL && constructor != NULL) {
            jstring java_message = (*env)->NewStringUTF(env, full_message);
            return (*env)->NewObject(env, java_error_cls, constructor, java_message);
        }
    }

    // Fallback to the default error class
    return new_qjs_exception(env, full_message);
}

jobjectArray to_java_list(JNIEnv *env, JSContext *context, JSValue value) {
    uint32_t len, i;
    JSValue js_arr_len = JS_GetPropertyStr(context, value, "length");
    JS_ToUint32(context, &len, js_arr_len);
    JS_FreeValue(context, js_arr_len);
    // Create a new java list
    jclass array_list_cls = cls_array_list(env);
    jmethodID array_list_constructor = method_array_list_init_with_capacity(env);
    jobject list = (*env)->NewObject(env, array_list_cls, array_list_constructor, len);
    jmethodID list_add_method = method_list_add(env);
    // Convert items
    for (i = 0; i < len; i++) {
        JSValue val = JS_GetPropertyUint32(context, value, i);
        jobject item = js_value_to_jobject(env, context, val);
        JS_FreeValue(context, val);
        (*env)->CallBooleanMethod(env, list, list_add_method, item);
        (*env)->DeleteLocalRef(env, item);
    }
    return list;
}

jobject to_java_set(JNIEnv *env, JSContext *context, JSValue set) {
    // Create a java set
    jclass set_cls = cls_linked_hash_set(env);
    jmethodID constructor = method_linked_hash_set_init(env);
    jmethodID add_method = method_linked_hash_set_add(env);
    jobject java_set = (*env)->NewObject(env, set_cls, constructor);

    JSValue keys_func = JS_GetPropertyStr(context, set, "keys");
    JSValue iterator = JS_Call(context, keys_func, set, 0, 0);
    JSValue next_func = JS_GetPropertyStr(context, iterator, "next");
    for (;;) {
        JSValue entry = JS_Call(context, next_func, iterator, 0, 0);

        JSValue done = JS_GetPropertyStr(context, entry, "done");
        if (JS_ToBool(context, done)) {
            JS_FreeValue(context, done);
            JS_FreeValue(context, entry);
            break;
        }

        JSValue key = JS_GetPropertyStr(context, entry, "value");

        jobject java_key = js_value_to_jobject(env, context, key);
        // Set.add()
        (*env)->CallBooleanMethod(env, java_set, add_method, java_key);
        (*env)->DeleteLocalRef(env, java_key);

        JS_FreeValue(context, key);
        JS_FreeValue(context, entry);
    }

    JS_FreeValue(context, next_func);
    JS_FreeValue(context, iterator);
    JS_FreeValue(context, keys_func);

    return java_set;
}

jobject to_java_map(JNIEnv *env, JSContext *context, JSValue map) {
    // Create a java map
    jclass map_cls = cls_linked_hash_map(env);
    jmethodID constructor = method_linked_hash_map_init(env);
    jmethodID put_method = method_linked_hash_map_put(env);
    jobject java_map = (*env)->NewObject(env, map_cls, constructor);

    JSValue entries_func = JS_GetPropertyStr(context, map, "entries");
    JSValue iterator = JS_Call(context, entries_func, map, 0, 0);
    JSValue next_func = JS_GetPropertyStr(context, iterator, "next");
    for (;;) {
        JSValue entry = JS_Call(context, next_func, iterator, 0, 0);
        JSValue done = JS_GetPropertyStr(context, entry, "done");
        if (JS_ToBool(context, done)) {
            JS_FreeValue(context, done);
            JS_FreeValue(context, entry);
            break;
        }

        // entry_value = [key, value]
        JSValue entry_value = JS_GetPropertyStr(context, entry, "value");
        JSValue key = JS_GetPropertyUint32(context, entry_value, 0);
        JSValue val = JS_GetPropertyUint32(context, entry_value, 1);

        jobject java_key = js_value_to_jobject(env, context, key);
        jobject java_val = js_value_to_jobject(env, context, val);
        // Map.put(k, v)
        (*env)->CallObjectMethod(env, java_map, put_method, java_key, java_val);
        (*env)->DeleteLocalRef(env, java_key);
        (*env)->DeleteLocalRef(env, java_val);

        JS_FreeValue(context, key);
        JS_FreeValue(context, val);
        JS_FreeValue(context, entry_value);
        JS_FreeValue(context, entry);
    }

    JS_FreeValue(context, next_func);
    JS_FreeValue(context, iterator);
    JS_FreeValue(context, entries_func);

    return java_map;
}

jobject object_to_java_js_object(JNIEnv *env, JSContext *context, JSValue value) {
    // This can check circular references for us
    JSValue json = JS_JSONStringify(context, value, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(json)) {
        JSValue js_err = JS_GetException(context);
        if (!JS_IsNull(js_err)) {
            (*env)->Throw(env, js_error_to_java_error(env, context, js_err));
        }
        JS_FreeValue(context, js_err);
        JS_FreeValue(context, json);
        return NULL;
    }
    JS_FreeValue(context, json);

    JSPropertyEnum *props;
    uint32_t prop_len;
    JS_GetOwnPropertyNames(context, &props, &prop_len, value,
                           JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK);
    // Create a java map
    jclass map_cls = cls_linked_hash_map(env);
    jmethodID constructor = method_linked_hash_map_init(env);
    jmethodID put_method = method_linked_hash_map_put(env);
    jobject java_map = (*env)->NewObject(env, map_cls, constructor);

    int value_tag = JS_VALUE_GET_TAG(value);
    void *value_ptr = JS_VALUE_GET_PTR(value);

    for (uint32_t i = 0; i < prop_len; i++) {
        JSAtom prop_atom = props[i].atom;
        JSValue key = JS_AtomToValue(context, prop_atom);
        JSValue val = JS_GetProperty(context, value, prop_atom);

        if (JS_IsNull(key) || JS_IsUndefined(key)) {
            goto free_values;
        }

        if (JS_VALUE_GET_TAG(key) == value_tag &&
            JS_VALUE_GET_PTR(key) == value_ptr) {
            // Avoid infinite recursion
            goto free_values;
        }

        jobject java_key = js_value_to_jobject(env, context, key);
        if (try_catch_java_exceptions(env) != NULL) {
            goto free_values;
        }

        jobject java_val;
        if (JS_VALUE_GET_TAG(val) == value_tag &&
            JS_VALUE_GET_PTR(val) == value_ptr) {
            // Avoid infinite recursion
            const char *val_str = JS_ToCString(context, val);
            java_val = to_java_string(env, val_str);
            JS_FreeCString(context, val_str);
        } else if (JS_IsFunction(context, val)) {
            java_val = to_java_string(env, "[Function]");
        } else {
            java_val = js_value_to_jobject(env, context, val);
            if (try_catch_java_exceptions(env) != NULL) {
                goto free_values;
            }
        }

        // Map.put(k, v)
        (*env)->CallObjectMethod(env, java_map, put_method, java_key, java_val);

        (*env)->DeleteLocalRef(env, java_key);
        (*env)->DeleteLocalRef(env, java_val);

        free_values:
        JS_FreeValue(context, key);
        JS_FreeValue(context, val);
        JS_FreeAtom(context, prop_atom);
    }

    js_free(context, props);

    // Wrap java_map as JsObject
    jclass js_object_cls = cls_js_object(env);
    jmethodID js_object_constructor = method_js_object_init(env);
    jobject js_object = (*env)->NewObject(env, js_object_cls, js_object_constructor, java_map);

    return js_object;
}

jobject js_int8array_to_java_byte_array(JNIEnv *env, JSContext *context, JSValue value) {
    JSValue buffer = JS_GetPropertyStr(context, value, "buffer");
    size_t size;
    uint8_t *c_buffer = JS_GetArrayBuffer(context, &size, buffer);
    if (c_buffer == NULL) {
        JS_FreeValue(context, buffer);
        jni_throw_qjs_exception(env, "Cannot read array buffer.");
        return NULL;
    }
    jbyteArray array = (*env)->NewByteArray(env, size);
    (*env)->SetByteArrayRegion(env, array, 0, size, (jbyte *) c_buffer);
    JS_FreeValue(context, buffer);
    return array;
}

jobject js_int8array_to_kt_ubyte_array(JNIEnv *env, JSContext *context, JSValue value) {
    jobject bytes = js_int8array_to_java_byte_array(env, context, value);
    if (bytes == NULL) {
        return NULL;
    }
    return (*env)->NewObject(env, cls_ubyte_array(env), method_ubyte_array_init(env), bytes);
}

jobject try_handle_promise_result(JNIEnv *env, JSContext *context, JSValue promise) {
    JSPromiseStateEnum state = JS_PromiseState(context, promise);
    if (state == JS_PROMISE_FULFILLED) {
        return (*env)->NewStringUTF(env, "Promise { <state>: \"fulfilled\" }");
    } else if (state == JS_PROMISE_REJECTED) {
        return (*env)->NewStringUTF(env, "Promise { <state>: \"rejected\" }");
    } else {
        return (*env)->NewStringUTF(env, "Promise { <state>: \"pending\" }");
    }
}

jobject js_value_to_jobject(JNIEnv *env, JSContext *context, JSValue value) {
    int tag = JS_VALUE_GET_TAG(value);
    if (JS_IsNull(value) || JS_IsUndefined(value)) {
        return NULL;
    } else if (JS_IsBool(value)) {
        // Boolean
        int val = JS_ToBool(context, value);
        return java_boxed_boolean(env, val == 1 ? JNI_TRUE : JNI_FALSE);
    } else if (JS_VALUE_IS_NAN(value)) {
        // NaN
        return java_boxed_nan_double(env);
    } else if (tag == JS_TAG_INT) {
        // Long
        int64_t i64;
        JS_ToInt64(context, &i64, value);
        return java_boxed_long(env, i64);
    } else if (tag == JS_TAG_FLOAT64) {
        // Double
        double f64;
        JS_ToFloat64(context, &f64, value);
        return java_boxed_double(env, f64);
    } else if (JS_IsString(value)) {
        // String
        const char *str = JS_ToCString(context, value);
        jobject result = to_java_string(env, str);
        JS_FreeCString(context, str);
        return result;
    } else if (JS_IsError(context, value)) {
        // Error
        return js_error_to_java_error(env, context, value);
    } else if (JS_IsArray(context, value)) {
        // Array
        return to_java_list(env, context, value);
    } else if (tag == JS_TAG_FUNCTION_BYTECODE || tag == JS_TAG_MODULE) {
        // Bytecode
        size_t length;
        uint8_t *buffer = JS_WriteObject(context, &length, value,
                                         JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_REFERENCE);
        if (buffer == NULL) {
            jni_throw_qjs_exception(env, "Failed to compiled JavaScript code.");
            return NULL;
        }

        jbyteArray java_buffer = (*env)->NewByteArray(env, length);
        (*env)->SetByteArrayRegion(env, java_buffer, 0, length, (jbyte *) buffer);

        js_free(context, buffer);

        return java_buffer;
    } else if (JS_IsObject(value)) {
        JSValue global_this = JS_GetGlobalObject(context);
        jobject result;

        if (js_is_promise_2(context, global_this, value)) {
            result = try_handle_promise_result(env, context, value);
        } else if (js_is_set(context, global_this, value)) {
            result = to_java_set(env, context, value);
        } else if (js_is_map(context, global_this, value)) {
            result = to_java_map(env, context, value);
        } else if (js_is_uint8array(context, global_this, value)) {
            result = js_int8array_to_kt_ubyte_array(env, context, value);
        } else if (js_is_int8array(context, global_this, value)) {
            result = js_int8array_to_java_byte_array(env, context, value);
        } else {
            result = object_to_java_js_object(env, context, value);
        }

        JS_FreeValue(context, global_this);

        return result;
    } else {
        const char *string = JS_ToCString(context, value);
        jni_throw_qjs_exception(env, "Unsupported js value type: %s, tag: %d", string, tag);
        JS_FreeCString(context, string);
        return NULL;
    }
}
