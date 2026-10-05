#include <string.h>
#include <stdlib.h>
#include "jobject_to_js_value.h"
#include "js_value_util.h"
#include "exception_util.h"
#include "log_util.h"
#include "jni_globals_generated.h"

void throw_circular_ref_error(JSContext *context) {
    const char *msg = "Unable to map objects with circular reference.";
    JSValue err = new_simple_js_error(context, msg);
    JS_Throw(context, err);
}

void visit_first(JNIEnv *env, jobject visited_set, jobject current) {
    if (current == NULL) {
        return;
    }
    if (!(*env)->CallBooleanMethod(env, visited_set, method_set_is_empty(env))) {
        return;
    }
    jint hash = (*env)->CallStaticIntMethod(env, cls_system(env),
                                            method_system_identity_hash_code(env), current);
    jobject hash_boxed = (*env)->CallStaticObjectMethod(env, cls_integer(env),
                                                        method_integer_value_of(env), hash);
    (*env)->CallBooleanMethod(env, visited_set, method_set_add(env), hash_boxed);
}

int visit_or_circular_ref_error(JNIEnv *env, JSContext *context,
                                jobject visited_set, jobject current) {
    if (current == NULL) {
        return 0;
    }
    jclass cls = (*env)->GetObjectClass(env, current);
    if (!(*env)->CallBooleanMethod(env, cls, method_class_is_array(env)) &&
        !(*env)->IsInstanceOf(env, current, cls_list(env)) &&
        !(*env)->IsInstanceOf(env, current, cls_set(env)) &&
        !(*env)->IsInstanceOf(env, current, cls_map(env)) &&
        !(*env)->IsInstanceOf(env, current, cls_js_object(env))) {
        return 0;
    }
    jint hash = (*env)->CallStaticIntMethod(env, cls_system(env),
                                            method_system_identity_hash_code(env), current);
    jobject hash_boxed = (*env)->CallStaticObjectMethod(env, cls_integer(env),
                                                        method_integer_value_of(env), hash);
    if ((*env)->CallBooleanMethod(env, visited_set, method_set_contains(env), hash_boxed)) {
        throw_circular_ref_error(context);
        return 1;
    } else {
        (*env)->CallBooleanMethod(env, visited_set, method_set_add(env), hash_boxed);
        return 0;
    }
}

JSValue java_list_to_js_array(JNIEnv *env, JSContext *context,
                              jobject visited_set, jobject java_list) {
    int delete_global_visited_ref = 0;
    if (visited_set == NULL) {
        jobject visited = (*env)->NewObject(env, cls_hash_set(env), method_hash_set_init(env));
        visited_set = (*env)->NewGlobalRef(env, visited);
        (*env)->DeleteLocalRef(env, visited);
        delete_global_visited_ref = 1;
    }
    visit_first(env, visited_set, java_list);

    JSValue js_array = JS_NewArray(context);
    jmethodID method_get = method_list_get(env);
    jint size = (*env)->CallIntMethod(env, java_list, method_list_size(env));
    int has_exception = 0;
    for (int i = 0; i < size && has_exception == 0; i++) {
        jobject element = (*env)->CallObjectMethod(env, java_list, method_get, i);
        // Check circular refs
        if (visit_or_circular_ref_error(env, context, visited_set, element)) {
            (*env)->DeleteLocalRef(env, element);
            has_exception = 1;
            break;
        }
        JSValue js_element = jobject_to_js_value(env, context, visited_set, element);
        if (!JS_IsException(js_element)) {
            JS_SetPropertyUint32(context, js_array, i, js_element);
        } else {
            has_exception = 1;
        }
        (*env)->DeleteLocalRef(env, element);
    }

    if (delete_global_visited_ref) {
        (*env)->DeleteGlobalRef(env, visited_set);
    }

    if (has_exception) {
        JS_FreeValue(context, js_array);
        return JS_EXCEPTION;
    } else {
        return js_array;
    }
}

JSValue new_js_object_from_constructor(JSContext *context, const char *constructor,
                                       int argc, JSValue *argv) {
    JSValue result;

    JSValue global_this = JS_GetGlobalObject(context);
    JSValue js_constructor = JS_GetPropertyStr(context, global_this, constructor);
    if (JS_IsUndefined(js_constructor)) {
        JS_FreeValue(context, global_this);
        char message[100];
        sprintf(message, "JS constructor '%s' not found.", constructor);
        JS_Throw(context, new_js_error(context, "TypeMappingError", message, 0, NULL));
        result = JS_EXCEPTION;
    } else {
        result = JS_CallConstructor(context, js_constructor, argc, argv);
    }

    JS_FreeValue(context, js_constructor);
    JS_FreeValue(context, global_this);

    return result;
}

JSValue java_set_to_js_set(JNIEnv *env, JSContext *context,
                           jobject visited_set, jobject java_set) {
    int delete_global_visited_ref = 0;
    if (visited_set == NULL) {
        jobject visited = (*env)->NewObject(env, cls_hash_set(env), method_hash_set_init(env));
        visited_set = (*env)->NewGlobalRef(env, visited);
        (*env)->DeleteLocalRef(env, visited);
        delete_global_visited_ref = 1;
    }
    visit_first(env, visited_set, java_set);

    jobject iterator = (*env)->CallObjectMethod(env, java_set, method_set_iterator(env));

    jmethodID method_has_next = method_iterator_has_next(env);
    jmethodID method_next = method_iterator_next(env);

    JSValue js_array = JS_NewArray(context);
    uint32_t index = 0;

    while ((*env)->CallBooleanMethod(env, iterator, method_has_next)) {
        jobject key = (*env)->CallObjectMethod(env, iterator, method_next);
        // Check circular refs
        if (visit_or_circular_ref_error(env, context, visited_set, key)) {
            JS_FreeValue(context, js_array);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteGlobalRef(env, visited_set);
            return JS_EXCEPTION;
        }
        JSValue item = jobject_to_js_value(env, context, visited_set, key);
        if (JS_IsException(item)) {
            (*env)->DeleteLocalRef(env, key);
            break;
        }
        JS_SetPropertyUint32(context, js_array, index, item);
        (*env)->DeleteLocalRef(env, key);
        index++;
    }

    if (delete_global_visited_ref) {
        (*env)->DeleteGlobalRef(env, visited_set);
    }

    int argc = 1;
    JSValue argv[] = {js_array};
    JSValue result = new_js_object_from_constructor(context, "Set", argc, argv);

    JS_FreeValue(context, js_array);

    return result;
}

JSValue java_map_to_js_map(JNIEnv *env, JSContext *context,
                           jobject visited_set, jobject java_map) {
    int delete_global_visited_ref = 0;
    if (visited_set == NULL) {
        jobject visited = (*env)->NewObject(env, cls_hash_set(env), method_hash_set_init(env));
        visited_set = (*env)->NewGlobalRef(env, visited);
        (*env)->DeleteLocalRef(env, visited);
        delete_global_visited_ref = 1;
    }
    visit_first(env, visited_set, java_map);

    jobject entry_set = (*env)->CallObjectMethod(env, java_map, method_map_entry_set(env));
    jobject iterator = (*env)->CallObjectMethod(env, entry_set, method_set_iterator(env));

    jmethodID method_has_next = method_iterator_has_next(env);
    jmethodID method_next = method_iterator_next(env);

    jmethodID method_get_key = method_map_entry_get_key(env);
    jmethodID method_get_val = method_map_entry_get_value(env);

    JSValue js_array = JS_NewArray(context);
    uint32_t index = 0;

    while ((*env)->CallBooleanMethod(env, iterator, method_has_next)) {
        jobject entry = (*env)->CallObjectMethod(env, iterator, method_next);
        jobject key = (*env)->CallObjectMethod(env, entry, method_get_key);

        // Check circular refs
        if (visit_or_circular_ref_error(env, context, visited_set, key)) {
            JS_FreeValue(context, js_array);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteGlobalRef(env, visited_set);
            return JS_EXCEPTION;
        }

        JSValue js_key = jobject_to_js_value(env, context, visited_set, key);
        if (JS_IsException(js_key)) {
            JS_FreeValue(context, js_array);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteGlobalRef(env, visited_set);
            return JS_EXCEPTION;
        }

        jobject value = (*env)->CallObjectMethod(env, entry, method_get_val);

        // Check circular refs
        if (visit_or_circular_ref_error(env, context, visited_set, value)) {
            JS_FreeValue(context, js_key);
            JS_FreeValue(context, js_array);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteLocalRef(env, value);
            (*env)->DeleteGlobalRef(env, visited_set);
            return JS_EXCEPTION;
        }

        JSValue js_value = jobject_to_js_value(env, context, visited_set, value);
        if (JS_IsException(js_value)) {
            JS_FreeValue(context, js_key);
            JS_FreeValue(context, js_array);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteLocalRef(env, value);
            (*env)->DeleteGlobalRef(env, visited_set);
            return JS_EXCEPTION;
        }

        JSValue js_entry = JS_NewArray(context);
        JS_SetPropertyUint32(context, js_entry, 0, js_key);
        JS_SetPropertyUint32(context, js_entry, 1, js_value);

        JS_SetPropertyUint32(context, js_array, index, js_entry);

        (*env)->DeleteLocalRef(env, entry);
        (*env)->DeleteLocalRef(env, key);
        (*env)->DeleteLocalRef(env, value);

        index++;
    }

    if (delete_global_visited_ref) {
        (*env)->DeleteGlobalRef(env, visited_set);
    }

    int argc = 1;
    JSValue argv[] = {js_array};
    JSValue result = new_js_object_from_constructor(context, "Map", argc, argv);

    JS_FreeValue(context, js_array);

    return result;
}

JSValue java_throwable_to_js_error(JNIEnv *env, JSContext *context, jthrowable throwable) {
    JSValue error = JS_NewError(context);

    jclass exceptionClass = (*env)->GetObjectClass(env, throwable);

    // Get class js_name
    jstring j_cls_name = (jstring) (*env)->CallObjectMethod(env, exceptionClass,
                                                            method_class_get_name(env));
    const char *cls_name = (*env)->GetStringUTFChars(env, j_cls_name, NULL);

    // Set error name
    JSValue js_name = JS_NewString(context, cls_name);
    JS_SetPropertyStr(context, error, "name", js_name);

    (*env)->ReleaseStringUTFChars(env, j_cls_name, cls_name);

    // Get message
    jstring j_message = (jstring) (*env)->CallObjectMethod(env, throwable,
                                                           method_throwable_get_message(env));
    if (j_message != NULL) {
        const char *message = (*env)->GetStringUTFChars(env, j_message, NULL);
        // Set message name
        JSValue js_message = JS_NewString(context, message);
        JS_SetPropertyStr(context, error, "message", js_message);
        (*env)->ReleaseStringUTFChars(env, j_message, message);
    } else {
        JSValue js_message = JS_NewString(context, "");
        JS_SetPropertyStr(context, error, "message", js_message);
    }

    // Get stack trace
    jmethodID get_stack_trace = method_throwable_get_stack_trace(env);
    jmethodID to_string = method_object_to_string(env);
    jobjectArray j_stack_trace = (jobjectArray) (*env)->CallObjectMethod(env, throwable,
                                                                         get_stack_trace);
    size_t stack_trace_line_count = (*env)->GetArrayLength(env, j_stack_trace);

    JSValue stack_trace = JS_NewArray(context);

    for (int i = 0; i < stack_trace_line_count; i++) {
        jobject element = (*env)->GetObjectArrayElement(env, j_stack_trace, i);
        jstring j_string = (jstring) (*env)->CallObjectMethod(env, element, to_string);
        const char *line_string = (*env)->GetStringUTFChars(env, j_string, NULL);

        // Set stack trace line
        JSValue line = JS_NewString(context, line_string);
        JS_SetPropertyUint32(context, stack_trace, i, line);

        (*env)->ReleaseStringUTFChars(env, j_string, line_string);
        (*env)->DeleteLocalRef(env, j_string);
        (*env)->DeleteLocalRef(env, element);
    }

    // Set stack trace
    JS_SetPropertyStr(context, error, "stack", stack_trace);

    return error;
}

JSValue java_map_to_js_object(JNIEnv *env, JSContext *context,
                              jobject visited_set, jobject java_map) {
    int delete_global_visited_ref = 0;
    if (visited_set == NULL) {
        jobject visited = (*env)->NewObject(env, cls_hash_set(env), method_hash_set_init(env));
        visited_set = (*env)->NewGlobalRef(env, visited);
        (*env)->DeleteLocalRef(env, visited);
        delete_global_visited_ref = 1;
    }
    visit_first(env, visited_set, java_map);

    jobject entry_set = (*env)->CallObjectMethod(env, java_map, method_map_entry_set(env));
    jobject iterator = (*env)->CallObjectMethod(env, entry_set, method_set_iterator(env));

    jclass cls_str = cls_string(env);

    jmethodID method_has_next = method_iterator_has_next(env);
    jmethodID method_next = method_iterator_next(env);

    jmethodID method_get_key = method_map_entry_get_key(env);
    jmethodID method_get_val = method_map_entry_get_value(env);

    JSValue js_object = JS_NewObject(context);

    while ((*env)->CallBooleanMethod(env, iterator, method_has_next)) {
        jobject entry = (*env)->CallObjectMethod(env, iterator, method_next);

        jobject key = (*env)->CallObjectMethod(env, entry, method_get_key);

        // Check circular refs
        if (visit_or_circular_ref_error(env, context, visited_set, key)) {
            JS_FreeValue(context, js_object);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteGlobalRef(env, visited_set);
            return JS_EXCEPTION;
        }

        // Check key type
        if ((*env)->IsInstanceOf(env, key, cls_str) == JNI_FALSE) {
            JS_FreeValue(context, js_object);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteGlobalRef(env, visited_set);
            const char *message = "Cannot convert java map to js value: "
                                  "only string keys are supported.";
            JS_Throw(context, new_js_error(context, "TypeMappingError", message, 0, NULL));
            return JS_EXCEPTION;
        }
        const char *str_key = (*env)->GetStringUTFChars(env, key, NULL);

        jobject value = (*env)->CallObjectMethod(env, entry, method_get_val);

        // Check circular refs
        if (visit_or_circular_ref_error(env, context, visited_set, value)) {
            JS_FreeValue(context, js_object);
            (*env)->ReleaseStringUTFChars(env, key, str_key);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteLocalRef(env, value);
            (*env)->DeleteGlobalRef(env, visited_set);
            return JS_EXCEPTION;
        }

        JSAtom js_key = JS_NewAtom(context, str_key);
        JSValue js_value = jobject_to_js_value(env, context, visited_set, value);
        if (JS_IsException(js_value)) {
            JS_FreeValue(context, js_object);
            (*env)->ReleaseStringUTFChars(env, key, str_key);
            (*env)->DeleteLocalRef(env, entry);
            (*env)->DeleteLocalRef(env, key);
            (*env)->DeleteLocalRef(env, value);
            (*env)->DeleteGlobalRef(env, visited_set);
            return js_value;
        }
        JS_SetProperty(context, js_object, js_key, js_value);
        JS_FreeAtom(context, js_key);

        (*env)->ReleaseStringUTFChars(env, key, str_key);
        (*env)->DeleteLocalRef(env, entry);
        (*env)->DeleteLocalRef(env, key);
        (*env)->DeleteLocalRef(env, value);
    }

    if (delete_global_visited_ref) {
        (*env)->DeleteGlobalRef(env, visited_set);
    }

    return js_object;
}

void js_free_array_buffer(JSRuntime *runtime, void *opaque, void *ptr) {
    free(ptr);
}

JSValue byte_array_to_js_byte_array(JNIEnv *env, JSContext *context, jobject value,
                                    const char *array_constructor_name) {
    size_t size = (*env)->GetArrayLength(env, value);
    jbyte *bytes = (*env)->GetByteArrayElements(env, value, NULL);
    uint8_t *c_buffer = malloc(size);
    memcpy(c_buffer, bytes, size);
    JSValue array_buffer = JS_NewArrayBuffer(context, c_buffer, size,
                                             js_free_array_buffer, NULL, 0);
    int argc = 1;
    JSValue argv[1] = {array_buffer};
    JSValue result = new_js_object_from_constructor(context, array_constructor_name,
                                                    argc, argv);
    JS_FreeValue(context, array_buffer);
    return result;
}

JSValue byte_array_to_js_int8array(JNIEnv *env, JSContext *context, jobject value) {
    return byte_array_to_js_byte_array(env, context, value, "Int8Array");
}

JSValue kt_ubyte_array_to_js_uint8array(JNIEnv *env, JSContext *context, jobject value) {
    jobject storage = (*env)->GetObjectField(env, value, field_ubyte_array_storage(env));
    return byte_array_to_js_byte_array(env, context, storage, "Uint8Array");
}

JSValue jobject_to_js_value(JNIEnv *env, JSContext *context, jobject visited_set, jobject value) {
    if (value == NULL) {
        return JS_NULL;
    }

    JSValue result = JS_UNDEFINED;

    if ((*env)->IsInstanceOf(env, value, cls_boolean(env))) {
        // Boolean
        jmethodID method = method_boolean_boolean_value(env);
        jboolean unboxed = (*env)->CallBooleanMethod(env, value, method);
        if (unboxed == JNI_TRUE) {
            result = JS_TRUE;
        } else {
            result = JS_FALSE;
        }
    } else if ((*env)->IsInstanceOf(env, value, cls_byte(env))) {
        // Byte
        jmethodID method = method_byte_byte_value(env);
        jbyte unboxed = (*env)->CallByteMethod(env, value, method);
        result = JS_NewInt32(context, unboxed);
    } else if ((*env)->IsInstanceOf(env, value, cls_short(env))) {
        // Short
        jmethodID method = method_short_short_value(env);
        jshort unboxed = (*env)->CallShortMethod(env, value, method);
        result = JS_NewInt32(context, unboxed);
    }  else if ((*env)->IsInstanceOf(env, value, cls_integer(env))) {
        // Integer
        jmethodID method = method_integer_int_value(env);
        jint unboxed = (*env)->CallIntMethod(env, value, method);
        result = JS_NewInt32(context, unboxed);
    } else if ((*env)->IsInstanceOf(env, value, cls_long(env))) {
        // Long
        jmethodID method = method_long_long_value(env);
        jlong unboxed = (*env)->CallLongMethod(env, value, method);
        result = JS_NewInt64(context, unboxed);
    } else if ((*env)->IsInstanceOf(env, value, cls_float(env))) {
        // Float
        jmethodID method = method_float_float_value(env);
        jfloat unboxed = (*env)->CallFloatMethod(env, value, method);
        result = JS_NewFloat64(context, unboxed);
    } else if ((*env)->IsInstanceOf(env, value, cls_double(env))) {
        // Double
        jmethodID method = method_double_double_value(env);
        jdouble unboxed = (*env)->CallDoubleMethod(env, value, method);
        result = JS_NewFloat64(context, unboxed);
    } else if ((*env)->IsInstanceOf(env, value, cls_string(env))) {
        // String
        const char *c_str = (*env)->GetStringUTFChars(env, value, NULL);
        JSValue js_value = JS_NewString(context, c_str);
        (*env)->ReleaseStringUTFChars(env, value, c_str);
        result = js_value;
    } else if ((*env)->IsInstanceOf(env, value, cls_list(env))) {
        // List
        result = java_list_to_js_array(env, context, visited_set, value);
    } else if ((*env)->IsInstanceOf(env, value, cls_js_object(env))) {
        // JsObject (A map delegate)
        result = java_map_to_js_object(env, context, visited_set, value);
    } else if ((*env)->IsInstanceOf(env, value, cls_map(env))) {
        // Map
        result = java_map_to_js_map(env, context, visited_set, value);
    } else if ((*env)->IsInstanceOf(env, value, cls_set(env))) {
        // Set
        result = java_set_to_js_set(env, context, visited_set, value);
    } else if ((*env)->IsInstanceOf(env, value, cls_throwable(env))) {
        // Throwable
        result = java_throwable_to_js_error(env, context, (jthrowable) value);
    } else if ((*env)->IsInstanceOf(env, value, cls_ubyte_array(env))) {
        // UByteArray
        result = kt_ubyte_array_to_js_uint8array(env, context, value);
    }

    if (!JS_IsUndefined(result)) {
        return result;
    }

    jclass cls = (*env)->GetObjectClass(env, value);
    jstring j_cls_name = (jstring) (*env)->CallObjectMethod(env, cls, method_class_get_name(env));
    const char *cls_name = (*env)->GetStringUTFChars(env, j_cls_name, NULL);

    // Try by the class name
    if (strcmp("kotlin.Unit", cls_name) == 0) {
        result = JS_UNDEFINED;
    } else if (strcmp("[B", cls_name) == 0) {
        result = byte_array_to_js_int8array(env, context, value);
    } else if (strcmp("[Z", cls_name) == 0) {
        // boolean array
        int size = (*env)->GetArrayLength(env, value);
        jboolean *arr = (*env)->GetBooleanArrayElements(env, value, NULL);
        JSValue js_array = JS_NewArray(context);
        for (uint32_t i = 0; i < size; i++) {
            JSValue js_element = JS_NewBool(context, arr[i] == JNI_TRUE);
            JS_SetPropertyUint32(context, js_array, i, js_element);
        }
        result = js_array;
        (*env)->ReleaseBooleanArrayElements(env, value, arr, 0);
    } else if (strcmp("[I", cls_name) == 0) {
        // int array
        int size = (*env)->GetArrayLength(env, value);
        jint *arr = (*env)->GetIntArrayElements(env, value, NULL);
        JSValue js_array = JS_NewArray(context);
        for (uint32_t i = 0; i < size; i++) {
            JSValue js_element = JS_NewInt32(context, arr[i]);
            JS_SetPropertyUint32(context, js_array, i, js_element);
        }
        result = js_array;
        (*env)->ReleaseIntArrayElements(env, value, arr, 0);
    } else if (strcmp("[J", cls_name) == 0) {
        // long array
        int size = (*env)->GetArrayLength(env, value);
        jlong *arr = (*env)->GetLongArrayElements(env, value, NULL);
        JSValue js_array = JS_NewArray(context);
        for (uint32_t i = 0; i < size; i++) {
            JSValue js_element = JS_NewInt64(context, arr[i]);
            JS_SetPropertyUint32(context, js_array, i, js_element);
        }
        result = js_array;
        (*env)->ReleaseLongArrayElements(env, value, arr, 0);
    } else if (strcmp("[F", cls_name) == 0) {
        // float array
        int size = (*env)->GetArrayLength(env, value);
        jfloat *arr = (*env)->GetFloatArrayElements(env, value, NULL);
        JSValue js_array = JS_NewArray(context);
        for (uint32_t i = 0; i < size; i++) {
            JSValue js_element = JS_NewFloat64(context, arr[i]);
            JS_SetPropertyUint32(context, js_array, i, js_element);
        }
        result = js_array;
        (*env)->ReleaseFloatArrayElements(env, value, arr, 0);
    } else if (strcmp("[D", cls_name) == 0) {
        // double array
        int size = (*env)->GetArrayLength(env, value);
        jdouble *arr = (*env)->GetDoubleArrayElements(env, value, NULL);
        JSValue js_array = JS_NewArray(context);
        for (uint32_t i = 0; i < size; i++) {
            JSValue js_element = JS_NewFloat64(context, arr[i]);
            JS_SetPropertyUint32(context, js_array, i, js_element);
        }
        result = js_array;
        (*env)->ReleaseDoubleArrayElements(env, value, arr, 0);
    } else if ('[' == cls_name[0]) {
        // Object array
        int size = (*env)->GetArrayLength(env, value);
        JSValue js_array = JS_NewArray(context);
        int has_exception = 0;
        for (uint32_t i = 0; i < size; i++) {
            jobject element = (*env)->GetObjectArrayElement(env, value, i);
            // Check circular refs
            if ((*env)->IsSameObject(env, value, element)) {
                JS_FreeValue(context, js_array);
                (*env)->DeleteLocalRef(env, element);
                throw_circular_ref_error(context);
                has_exception = 1;
                break;
            }
            JSValue js_element = jobject_to_js_value(env, context, visited_set, element);
            JS_SetPropertyUint32(context, js_array, i, js_element);
            (*env)->DeleteLocalRef(env, element);
        }
        if (has_exception) {
            result = JS_EXCEPTION;
        } else {
            result = js_array;
        }
    } else {
        char message[100];
        sprintf(message, "Cannot convert java type '%s' to a js value.", cls_name);
        JS_Throw(context, new_js_error(context, "TypeError", message, 0, NULL));
        result = JS_EXCEPTION;
    }

    (*env)->ReleaseStringUTFChars(env, j_cls_name, cls_name);

    return result;
}
