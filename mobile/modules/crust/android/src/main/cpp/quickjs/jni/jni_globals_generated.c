/// Generated source file
#include "jni_globals_generated.h"

// Cached classes
static jclass _cls_ubyte_array = NULL;
static jclass _cls_short = NULL;
static jclass _cls_byte = NULL;
static jclass _cls_integer = NULL;
static jclass _cls_long = NULL;
static jclass _cls_float = NULL;
static jclass _cls_double = NULL;
static jclass _cls_boolean = NULL;
static jclass _cls_string = NULL;
static jclass _cls_object = NULL;
static jclass _cls_system = NULL;
static jclass _cls_class = NULL;
static jclass _cls_throwable = NULL;
static jclass _cls_set = NULL;
static jclass _cls_iterator = NULL;
static jclass _cls_list = NULL;
static jclass _cls_array_list = NULL;
static jclass _cls_map = NULL;
static jclass _cls_map_entry = NULL;
static jclass _cls_hash_set = NULL;
static jclass _cls_linked_hash_map = NULL;
static jclass _cls_linked_hash_set = NULL;
static jclass _cls_quick_js_exception = NULL;
static jclass _cls_quick_js = NULL;
static jclass _cls_memory_usage = NULL;
static jclass _cls_js_property = NULL;
static jclass _cls_js_function = NULL;
static jclass _cls_js_object = NULL;

// Cached methods
static jmethodID _method_ubyte_array_init = NULL;
static jmethodID _method_short_short_value = NULL;
static jmethodID _method_byte_byte_value = NULL;
static jmethodID _method_integer_value_of = NULL;
static jmethodID _method_integer_int_value = NULL;
static jmethodID _method_long_value_of = NULL;
static jmethodID _method_long_long_value = NULL;
static jmethodID _method_float_float_value = NULL;
static jmethodID _method_double_value_of = NULL;
static jmethodID _method_double_double_value = NULL;
static jmethodID _method_boolean_value_of = NULL;
static jmethodID _method_boolean_boolean_value = NULL;
static jmethodID _method_object_to_string = NULL;
static jmethodID _method_system_identity_hash_code = NULL;
static jmethodID _method_class_get_name = NULL;
static jmethodID _method_class_is_array = NULL;
static jmethodID _method_throwable_get_message = NULL;
static jmethodID _method_throwable_get_stack_trace = NULL;
static jmethodID _method_set_iterator = NULL;
static jmethodID _method_set_add = NULL;
static jmethodID _method_set_contains = NULL;
static jmethodID _method_set_is_empty = NULL;
static jmethodID _method_iterator_has_next = NULL;
static jmethodID _method_iterator_next = NULL;
static jmethodID _method_list_size = NULL;
static jmethodID _method_list_get = NULL;
static jmethodID _method_list_add = NULL;
static jmethodID _method_array_list_init = NULL;
static jmethodID _method_array_list_init_with_capacity = NULL;
static jmethodID _method_map_entry_set = NULL;
static jmethodID _method_map_entry_get_key = NULL;
static jmethodID _method_map_entry_get_value = NULL;
static jmethodID _method_hash_set_init = NULL;
static jmethodID _method_linked_hash_map_init = NULL;
static jmethodID _method_linked_hash_map_put = NULL;
static jmethodID _method_linked_hash_set_init = NULL;
static jmethodID _method_linked_hash_set_add = NULL;
static jmethodID _method_quick_js_exception_init = NULL;
static jmethodID _method_quick_js_on_call_getter = NULL;
static jmethodID _method_quick_js_on_call_setter = NULL;
static jmethodID _method_quick_js_on_call_function = NULL;
static jmethodID _method_quick_js_set_eval_exception = NULL;
static jmethodID _method_quick_js_set_unhandled_promise_rejection = NULL;
static jmethodID _method_memory_usage_init = NULL;
static jmethodID _method_js_object_init = NULL;

// Cached fields
static jfieldID _field_ubyte_array_storage = NULL;
static jfieldID _field_double_na_n = NULL;
static jfieldID _field_js_property_name = NULL;
static jfieldID _field_js_property_configurable = NULL;
static jfieldID _field_js_property_writable = NULL;
static jfieldID _field_js_property_enumerable = NULL;
static jfieldID _field_js_function_name = NULL;
static jfieldID _field_js_function_is_async = NULL;

jclass cls_ubyte_array(JNIEnv *env) {
    if (_cls_ubyte_array == NULL) {
        jclass cls = (*env)->FindClass(env, "kotlin/UByteArray");
        _cls_ubyte_array = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_ubyte_array;
}

jclass cls_short(JNIEnv *env) {
    if (_cls_short == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Short");
        _cls_short = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_short;
}

jclass cls_byte(JNIEnv *env) {
    if (_cls_byte == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Byte");
        _cls_byte = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_byte;
}

jclass cls_integer(JNIEnv *env) {
    if (_cls_integer == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Integer");
        _cls_integer = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_integer;
}

jclass cls_long(JNIEnv *env) {
    if (_cls_long == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Long");
        _cls_long = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_long;
}

jclass cls_float(JNIEnv *env) {
    if (_cls_float == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Float");
        _cls_float = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_float;
}

jclass cls_double(JNIEnv *env) {
    if (_cls_double == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Double");
        _cls_double = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_double;
}

jclass cls_boolean(JNIEnv *env) {
    if (_cls_boolean == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Boolean");
        _cls_boolean = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_boolean;
}

jclass cls_string(JNIEnv *env) {
    if (_cls_string == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/String");
        _cls_string = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_string;
}

jclass cls_object(JNIEnv *env) {
    if (_cls_object == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Object");
        _cls_object = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_object;
}

jclass cls_system(JNIEnv *env) {
    if (_cls_system == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/System");
        _cls_system = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_system;
}

jclass cls_class(JNIEnv *env) {
    if (_cls_class == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Class");
        _cls_class = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_class;
}

jclass cls_throwable(JNIEnv *env) {
    if (_cls_throwable == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/Throwable");
        _cls_throwable = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_throwable;
}

jclass cls_set(JNIEnv *env) {
    if (_cls_set == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/Set");
        _cls_set = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_set;
}

jclass cls_iterator(JNIEnv *env) {
    if (_cls_iterator == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/Iterator");
        _cls_iterator = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_iterator;
}

jclass cls_list(JNIEnv *env) {
    if (_cls_list == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/List");
        _cls_list = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_list;
}

jclass cls_array_list(JNIEnv *env) {
    if (_cls_array_list == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/ArrayList");
        _cls_array_list = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_array_list;
}

jclass cls_map(JNIEnv *env) {
    if (_cls_map == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/Map");
        _cls_map = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_map;
}

jclass cls_map_entry(JNIEnv *env) {
    if (_cls_map_entry == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/Map$Entry");
        _cls_map_entry = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_map_entry;
}

jclass cls_hash_set(JNIEnv *env) {
    if (_cls_hash_set == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/HashSet");
        _cls_hash_set = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_hash_set;
}

jclass cls_linked_hash_map(JNIEnv *env) {
    if (_cls_linked_hash_map == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/LinkedHashMap");
        _cls_linked_hash_map = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_linked_hash_map;
}

jclass cls_linked_hash_set(JNIEnv *env) {
    if (_cls_linked_hash_set == NULL) {
        jclass cls = (*env)->FindClass(env, "java/util/LinkedHashSet");
        _cls_linked_hash_set = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_linked_hash_set;
}

jclass cls_quick_js_exception(JNIEnv *env) {
    if (_cls_quick_js_exception == NULL) {
        jclass cls = (*env)->FindClass(env, "com/dokar/quickjs/QuickJsException");
        _cls_quick_js_exception = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_quick_js_exception;
}

jclass cls_quick_js(JNIEnv *env) {
    if (_cls_quick_js == NULL) {
        jclass cls = (*env)->FindClass(env, "com/dokar/quickjs/QuickJs");
        _cls_quick_js = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_quick_js;
}

jclass cls_memory_usage(JNIEnv *env) {
    if (_cls_memory_usage == NULL) {
        jclass cls = (*env)->FindClass(env, "com/dokar/quickjs/MemoryUsage");
        _cls_memory_usage = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_memory_usage;
}

jclass cls_js_property(JNIEnv *env) {
    if (_cls_js_property == NULL) {
        jclass cls = (*env)->FindClass(env, "com/dokar/quickjs/binding/JsProperty");
        _cls_js_property = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_js_property;
}

jclass cls_js_function(JNIEnv *env) {
    if (_cls_js_function == NULL) {
        jclass cls = (*env)->FindClass(env, "com/dokar/quickjs/binding/JsFunction");
        _cls_js_function = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_js_function;
}

jclass cls_js_object(JNIEnv *env) {
    if (_cls_js_object == NULL) {
        jclass cls = (*env)->FindClass(env, "com/dokar/quickjs/binding/JsObject");
        _cls_js_object = (*env)->NewGlobalRef(env, cls);
    }
    return _cls_js_object;
}

jmethodID method_ubyte_array_init(JNIEnv *env) {
    if (_method_ubyte_array_init == NULL) {
        _method_ubyte_array_init = (*env)->GetMethodID(env, cls_ubyte_array(env), "<init>", "([B)V");
    }
    return _method_ubyte_array_init;
}

jmethodID method_short_short_value(JNIEnv *env) {
    if (_method_short_short_value == NULL) {
        _method_short_short_value = (*env)->GetMethodID(env, cls_short(env), "shortValue", "()S");
    }
    return _method_short_short_value;
}

jmethodID method_byte_byte_value(JNIEnv *env) {
    if (_method_byte_byte_value == NULL) {
        _method_byte_byte_value = (*env)->GetMethodID(env, cls_byte(env), "byteValue", "()B");
    }
    return _method_byte_byte_value;
}

jmethodID method_integer_value_of(JNIEnv *env) {
    if (_method_integer_value_of == NULL) {
        _method_integer_value_of = (*env)->GetStaticMethodID(env, cls_integer(env), "valueOf", "(I)Ljava/lang/Integer;");
    }
    return _method_integer_value_of;
}

jmethodID method_integer_int_value(JNIEnv *env) {
    if (_method_integer_int_value == NULL) {
        _method_integer_int_value = (*env)->GetMethodID(env, cls_integer(env), "intValue", "()I");
    }
    return _method_integer_int_value;
}

jmethodID method_long_value_of(JNIEnv *env) {
    if (_method_long_value_of == NULL) {
        _method_long_value_of = (*env)->GetStaticMethodID(env, cls_long(env), "valueOf", "(J)Ljava/lang/Long;");
    }
    return _method_long_value_of;
}

jmethodID method_long_long_value(JNIEnv *env) {
    if (_method_long_long_value == NULL) {
        _method_long_long_value = (*env)->GetMethodID(env, cls_long(env), "longValue", "()J");
    }
    return _method_long_long_value;
}

jmethodID method_float_float_value(JNIEnv *env) {
    if (_method_float_float_value == NULL) {
        _method_float_float_value = (*env)->GetMethodID(env, cls_float(env), "floatValue", "()F");
    }
    return _method_float_float_value;
}

jmethodID method_double_value_of(JNIEnv *env) {
    if (_method_double_value_of == NULL) {
        _method_double_value_of = (*env)->GetStaticMethodID(env, cls_double(env), "valueOf", "(D)Ljava/lang/Double;");
    }
    return _method_double_value_of;
}

jmethodID method_double_double_value(JNIEnv *env) {
    if (_method_double_double_value == NULL) {
        _method_double_double_value = (*env)->GetMethodID(env, cls_double(env), "doubleValue", "()D");
    }
    return _method_double_double_value;
}

jmethodID method_boolean_value_of(JNIEnv *env) {
    if (_method_boolean_value_of == NULL) {
        _method_boolean_value_of = (*env)->GetStaticMethodID(env, cls_boolean(env), "valueOf", "(Z)Ljava/lang/Boolean;");
    }
    return _method_boolean_value_of;
}

jmethodID method_boolean_boolean_value(JNIEnv *env) {
    if (_method_boolean_boolean_value == NULL) {
        _method_boolean_boolean_value = (*env)->GetMethodID(env, cls_boolean(env), "booleanValue", "()Z");
    }
    return _method_boolean_boolean_value;
}

jmethodID method_object_to_string(JNIEnv *env) {
    if (_method_object_to_string == NULL) {
        _method_object_to_string = (*env)->GetMethodID(env, cls_object(env), "toString", "()Ljava/lang/String;");
    }
    return _method_object_to_string;
}

jmethodID method_system_identity_hash_code(JNIEnv *env) {
    if (_method_system_identity_hash_code == NULL) {
        _method_system_identity_hash_code = (*env)->GetStaticMethodID(env, cls_system(env), "identityHashCode", "(Ljava/lang/Object;)I");
    }
    return _method_system_identity_hash_code;
}

jmethodID method_class_get_name(JNIEnv *env) {
    if (_method_class_get_name == NULL) {
        _method_class_get_name = (*env)->GetMethodID(env, cls_class(env), "getName", "()Ljava/lang/String;");
    }
    return _method_class_get_name;
}

jmethodID method_class_is_array(JNIEnv *env) {
    if (_method_class_is_array == NULL) {
        _method_class_is_array = (*env)->GetMethodID(env, cls_class(env), "isArray", "()Z");
    }
    return _method_class_is_array;
}

jmethodID method_throwable_get_message(JNIEnv *env) {
    if (_method_throwable_get_message == NULL) {
        _method_throwable_get_message = (*env)->GetMethodID(env, cls_throwable(env), "getMessage", "()Ljava/lang/String;");
    }
    return _method_throwable_get_message;
}

jmethodID method_throwable_get_stack_trace(JNIEnv *env) {
    if (_method_throwable_get_stack_trace == NULL) {
        _method_throwable_get_stack_trace = (*env)->GetMethodID(env, cls_throwable(env), "getStackTrace", "()[Ljava/lang/StackTraceElement;");
    }
    return _method_throwable_get_stack_trace;
}

jmethodID method_set_iterator(JNIEnv *env) {
    if (_method_set_iterator == NULL) {
        _method_set_iterator = (*env)->GetMethodID(env, cls_set(env), "iterator", "()Ljava/util/Iterator;");
    }
    return _method_set_iterator;
}

jmethodID method_set_add(JNIEnv *env) {
    if (_method_set_add == NULL) {
        _method_set_add = (*env)->GetMethodID(env, cls_set(env), "add", "(Ljava/lang/Object;)Z");
    }
    return _method_set_add;
}

jmethodID method_set_contains(JNIEnv *env) {
    if (_method_set_contains == NULL) {
        _method_set_contains = (*env)->GetMethodID(env, cls_set(env), "contains", "(Ljava/lang/Object;)Z");
    }
    return _method_set_contains;
}

jmethodID method_set_is_empty(JNIEnv *env) {
    if (_method_set_is_empty == NULL) {
        _method_set_is_empty = (*env)->GetMethodID(env, cls_set(env), "isEmpty", "()Z");
    }
    return _method_set_is_empty;
}

jmethodID method_iterator_has_next(JNIEnv *env) {
    if (_method_iterator_has_next == NULL) {
        _method_iterator_has_next = (*env)->GetMethodID(env, cls_iterator(env), "hasNext", "()Z");
    }
    return _method_iterator_has_next;
}

jmethodID method_iterator_next(JNIEnv *env) {
    if (_method_iterator_next == NULL) {
        _method_iterator_next = (*env)->GetMethodID(env, cls_iterator(env), "next", "()Ljava/lang/Object;");
    }
    return _method_iterator_next;
}

jmethodID method_list_size(JNIEnv *env) {
    if (_method_list_size == NULL) {
        _method_list_size = (*env)->GetMethodID(env, cls_list(env), "size", "()I");
    }
    return _method_list_size;
}

jmethodID method_list_get(JNIEnv *env) {
    if (_method_list_get == NULL) {
        _method_list_get = (*env)->GetMethodID(env, cls_list(env), "get", "(I)Ljava/lang/Object;");
    }
    return _method_list_get;
}

jmethodID method_list_add(JNIEnv *env) {
    if (_method_list_add == NULL) {
        _method_list_add = (*env)->GetMethodID(env, cls_list(env), "add", "(Ljava/lang/Object;)Z");
    }
    return _method_list_add;
}

jmethodID method_array_list_init(JNIEnv *env) {
    if (_method_array_list_init == NULL) {
        _method_array_list_init = (*env)->GetMethodID(env, cls_array_list(env), "<init>", "()V");
    }
    return _method_array_list_init;
}

jmethodID method_array_list_init_with_capacity(JNIEnv *env) {
    if (_method_array_list_init_with_capacity == NULL) {
        _method_array_list_init_with_capacity = (*env)->GetMethodID(env, cls_array_list(env), "<init>", "(I)V");
    }
    return _method_array_list_init_with_capacity;
}

jmethodID method_map_entry_set(JNIEnv *env) {
    if (_method_map_entry_set == NULL) {
        _method_map_entry_set = (*env)->GetMethodID(env, cls_map(env), "entrySet", "()Ljava/util/Set;");
    }
    return _method_map_entry_set;
}

jmethodID method_map_entry_get_key(JNIEnv *env) {
    if (_method_map_entry_get_key == NULL) {
        _method_map_entry_get_key = (*env)->GetMethodID(env, cls_map_entry(env), "getKey", "()Ljava/lang/Object;");
    }
    return _method_map_entry_get_key;
}

jmethodID method_map_entry_get_value(JNIEnv *env) {
    if (_method_map_entry_get_value == NULL) {
        _method_map_entry_get_value = (*env)->GetMethodID(env, cls_map_entry(env), "getValue", "()Ljava/lang/Object;");
    }
    return _method_map_entry_get_value;
}

jmethodID method_hash_set_init(JNIEnv *env) {
    if (_method_hash_set_init == NULL) {
        _method_hash_set_init = (*env)->GetMethodID(env, cls_hash_set(env), "<init>", "()V");
    }
    return _method_hash_set_init;
}

jmethodID method_linked_hash_map_init(JNIEnv *env) {
    if (_method_linked_hash_map_init == NULL) {
        _method_linked_hash_map_init = (*env)->GetMethodID(env, cls_linked_hash_map(env), "<init>", "()V");
    }
    return _method_linked_hash_map_init;
}

jmethodID method_linked_hash_map_put(JNIEnv *env) {
    if (_method_linked_hash_map_put == NULL) {
        _method_linked_hash_map_put = (*env)->GetMethodID(env, cls_linked_hash_map(env), "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
    }
    return _method_linked_hash_map_put;
}

jmethodID method_linked_hash_set_init(JNIEnv *env) {
    if (_method_linked_hash_set_init == NULL) {
        _method_linked_hash_set_init = (*env)->GetMethodID(env, cls_linked_hash_set(env), "<init>", "()V");
    }
    return _method_linked_hash_set_init;
}

jmethodID method_linked_hash_set_add(JNIEnv *env) {
    if (_method_linked_hash_set_add == NULL) {
        _method_linked_hash_set_add = (*env)->GetMethodID(env, cls_linked_hash_set(env), "add", "(Ljava/lang/Object;)Z");
    }
    return _method_linked_hash_set_add;
}

jmethodID method_quick_js_exception_init(JNIEnv *env) {
    if (_method_quick_js_exception_init == NULL) {
        _method_quick_js_exception_init = (*env)->GetMethodID(env, cls_quick_js_exception(env), "<init>", "(Ljava/lang/String;)V");
    }
    return _method_quick_js_exception_init;
}

jmethodID method_quick_js_on_call_getter(JNIEnv *env) {
    if (_method_quick_js_on_call_getter == NULL) {
        _method_quick_js_on_call_getter = (*env)->GetMethodID(env, cls_quick_js(env), "onCallGetter", "(JLjava/lang/String;)Ljava/lang/Object;");
    }
    return _method_quick_js_on_call_getter;
}

jmethodID method_quick_js_on_call_setter(JNIEnv *env) {
    if (_method_quick_js_on_call_setter == NULL) {
        _method_quick_js_on_call_setter = (*env)->GetMethodID(env, cls_quick_js(env), "onCallSetter", "(JLjava/lang/String;Ljava/lang/Object;)V");
    }
    return _method_quick_js_on_call_setter;
}

jmethodID method_quick_js_on_call_function(JNIEnv *env) {
    if (_method_quick_js_on_call_function == NULL) {
        _method_quick_js_on_call_function = (*env)->GetMethodID(env, cls_quick_js(env), "onCallFunction", "(JLjava/lang/String;[Ljava/lang/Object;)Ljava/lang/Object;");
    }
    return _method_quick_js_on_call_function;
}

jmethodID method_quick_js_set_eval_exception(JNIEnv *env) {
    if (_method_quick_js_set_eval_exception == NULL) {
        _method_quick_js_set_eval_exception = (*env)->GetMethodID(env, cls_quick_js(env), "setEvalException", "(Ljava/lang/Throwable;)V");
    }
    return _method_quick_js_set_eval_exception;
}

jmethodID method_quick_js_set_unhandled_promise_rejection(JNIEnv *env) {
    if (_method_quick_js_set_unhandled_promise_rejection == NULL) {
        _method_quick_js_set_unhandled_promise_rejection = (*env)->GetMethodID(env, cls_quick_js(env), "setUnhandledPromiseRejection", "(Ljava/lang/Object;)V");
    }
    return _method_quick_js_set_unhandled_promise_rejection;
}

jmethodID method_memory_usage_init(JNIEnv *env) {
    if (_method_memory_usage_init == NULL) {
        _method_memory_usage_init = (*env)->GetMethodID(env, cls_memory_usage(env), "<init>", "(JJJJJJJJJJJJJJJJJJJJJJJJJJ)V");
    }
    return _method_memory_usage_init;
}

jmethodID method_js_object_init(JNIEnv *env) {
    if (_method_js_object_init == NULL) {
        _method_js_object_init = (*env)->GetMethodID(env, cls_js_object(env), "<init>", "(Ljava/util/Map;)V");
    }
    return _method_js_object_init;
}

jfieldID field_ubyte_array_storage(JNIEnv *env) {
    if (_field_ubyte_array_storage == NULL) {
        _field_ubyte_array_storage = (*env)->GetFieldID(env, cls_ubyte_array(env), "storage", "[B");
    }
    return _field_ubyte_array_storage;
}

jfieldID field_double_na_n(JNIEnv *env) {
    if (_field_double_na_n == NULL) {
        _field_double_na_n = (*env)->GetStaticFieldID(env, cls_double(env), "NaN", "D");
    }
    return _field_double_na_n;
}

jfieldID field_js_property_name(JNIEnv *env) {
    if (_field_js_property_name == NULL) {
        _field_js_property_name = (*env)->GetFieldID(env, cls_js_property(env), "name", "Ljava/lang/String;");
    }
    return _field_js_property_name;
}

jfieldID field_js_property_configurable(JNIEnv *env) {
    if (_field_js_property_configurable == NULL) {
        _field_js_property_configurable = (*env)->GetFieldID(env, cls_js_property(env), "configurable", "Z");
    }
    return _field_js_property_configurable;
}

jfieldID field_js_property_writable(JNIEnv *env) {
    if (_field_js_property_writable == NULL) {
        _field_js_property_writable = (*env)->GetFieldID(env, cls_js_property(env), "writable", "Z");
    }
    return _field_js_property_writable;
}

jfieldID field_js_property_enumerable(JNIEnv *env) {
    if (_field_js_property_enumerable == NULL) {
        _field_js_property_enumerable = (*env)->GetFieldID(env, cls_js_property(env), "enumerable", "Z");
    }
    return _field_js_property_enumerable;
}

jfieldID field_js_function_name(JNIEnv *env) {
    if (_field_js_function_name == NULL) {
        _field_js_function_name = (*env)->GetFieldID(env, cls_js_function(env), "name", "Ljava/lang/String;");
    }
    return _field_js_function_name;
}

jfieldID field_js_function_is_async(JNIEnv *env) {
    if (_field_js_function_is_async == NULL) {
        _field_js_function_is_async = (*env)->GetFieldID(env, cls_js_function(env), "isAsync", "Z");
    }
    return _field_js_function_is_async;
}

void clear_jni_refs_cache(JNIEnv *env) {
    if (_cls_ubyte_array != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_ubyte_array);
    }
    if (_cls_short != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_short);
    }
    if (_cls_byte != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_byte);
    }
    if (_cls_integer != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_integer);
    }
    if (_cls_long != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_long);
    }
    if (_cls_float != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_float);
    }
    if (_cls_double != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_double);
    }
    if (_cls_boolean != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_boolean);
    }
    if (_cls_string != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_string);
    }
    if (_cls_object != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_object);
    }
    if (_cls_system != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_system);
    }
    if (_cls_class != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_class);
    }
    if (_cls_throwable != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_throwable);
    }
    if (_cls_set != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_set);
    }
    if (_cls_iterator != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_iterator);
    }
    if (_cls_list != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_list);
    }
    if (_cls_array_list != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_array_list);
    }
    if (_cls_map != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_map);
    }
    if (_cls_map_entry != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_map_entry);
    }
    if (_cls_hash_set != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_hash_set);
    }
    if (_cls_linked_hash_map != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_linked_hash_map);
    }
    if (_cls_linked_hash_set != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_linked_hash_set);
    }
    if (_cls_quick_js_exception != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_quick_js_exception);
    }
    if (_cls_quick_js != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_quick_js);
    }
    if (_cls_memory_usage != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_memory_usage);
    }
    if (_cls_js_property != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_js_property);
    }
    if (_cls_js_function != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_js_function);
    }
    if (_cls_js_object != NULL) {
        (*env)->DeleteGlobalRef(env, _cls_js_object);
    }

    _cls_ubyte_array = NULL;
    _cls_short = NULL;
    _cls_byte = NULL;
    _cls_integer = NULL;
    _cls_long = NULL;
    _cls_float = NULL;
    _cls_double = NULL;
    _cls_boolean = NULL;
    _cls_string = NULL;
    _cls_object = NULL;
    _cls_system = NULL;
    _cls_class = NULL;
    _cls_throwable = NULL;
    _cls_set = NULL;
    _cls_iterator = NULL;
    _cls_list = NULL;
    _cls_array_list = NULL;
    _cls_map = NULL;
    _cls_map_entry = NULL;
    _cls_hash_set = NULL;
    _cls_linked_hash_map = NULL;
    _cls_linked_hash_set = NULL;
    _cls_quick_js_exception = NULL;
    _cls_quick_js = NULL;
    _cls_memory_usage = NULL;
    _cls_js_property = NULL;
    _cls_js_function = NULL;
    _cls_js_object = NULL;

    _method_ubyte_array_init = NULL;
    _method_short_short_value = NULL;
    _method_byte_byte_value = NULL;
    _method_integer_value_of = NULL;
    _method_integer_int_value = NULL;
    _method_long_value_of = NULL;
    _method_long_long_value = NULL;
    _method_float_float_value = NULL;
    _method_double_value_of = NULL;
    _method_double_double_value = NULL;
    _method_boolean_value_of = NULL;
    _method_boolean_boolean_value = NULL;
    _method_object_to_string = NULL;
    _method_system_identity_hash_code = NULL;
    _method_class_get_name = NULL;
    _method_class_is_array = NULL;
    _method_throwable_get_message = NULL;
    _method_throwable_get_stack_trace = NULL;
    _method_set_iterator = NULL;
    _method_set_add = NULL;
    _method_set_contains = NULL;
    _method_set_is_empty = NULL;
    _method_iterator_has_next = NULL;
    _method_iterator_next = NULL;
    _method_list_size = NULL;
    _method_list_get = NULL;
    _method_list_add = NULL;
    _method_array_list_init = NULL;
    _method_array_list_init_with_capacity = NULL;
    _method_map_entry_set = NULL;
    _method_map_entry_get_key = NULL;
    _method_map_entry_get_value = NULL;
    _method_hash_set_init = NULL;
    _method_linked_hash_map_init = NULL;
    _method_linked_hash_map_put = NULL;
    _method_linked_hash_set_init = NULL;
    _method_linked_hash_set_add = NULL;
    _method_quick_js_exception_init = NULL;
    _method_quick_js_on_call_getter = NULL;
    _method_quick_js_on_call_setter = NULL;
    _method_quick_js_on_call_function = NULL;
    _method_quick_js_set_eval_exception = NULL;
    _method_quick_js_set_unhandled_promise_rejection = NULL;
    _method_memory_usage_init = NULL;
    _method_js_object_init = NULL;

    _field_ubyte_array_storage = NULL;
    _field_double_na_n = NULL;
    _field_js_property_name = NULL;
    _field_js_property_configurable = NULL;
    _field_js_property_writable = NULL;
    _field_js_property_enumerable = NULL;
    _field_js_function_name = NULL;
    _field_js_function_is_async = NULL;
}
