#ifndef QJS_KT_JS_VALUE_UTIL_H
#define QJS_KT_JS_VALUE_UTIL_H

#include "quickjs.h"

/**
 * Join array to string.
 *
 * @return NULL if failed to join, when successful, free() is required.
 */
char *js_array_join(JSContext *context, JSValue array, const char *separator);

/**
 * Join the js error message and stack trace (if any).
 *
 * @param context The js context.
 * @param error The error js value.
 * @param out Destination string pointer.
 */
void js_error_to_string(JSContext *context, JSValue error, char **out);

/**
 * Create a js error with a message field.
 */
JSValue new_simple_js_error(JSContext *context, const char *message);

/**
 * Create a js error.
 */
JSValue new_js_error(JSContext *context,
                     const char *name,
                     const char *message,
                     uint32_t stack_trace_lines,
                     const char **stack_trace);

/**
 * Check if the js value is a Promise.
 */
int js_is_promise(JSContext *context, JSValue value);

/**
 * Check if the js value is a Promise.
 */
int js_is_promise_2(JSContext *context, JSValue global_this, JSValue value);

/**
 * Check if the js value is a Uint8Array.
 */
int js_is_uint8array(JSContext *context, JSValue global_this, JSValue value);

/**
 * Check if the js value is a Int8Array.
 */
int js_is_int8array(JSContext *context, JSValue global_this, JSValue value);

/**
 * Check if the js value is a Set.
 */
int js_is_set(JSContext *context, JSValue global_this, JSValue value);

/**
 * Check if the js value is a Map.
 */
int js_is_map(JSContext *context, JSValue global_this, JSValue value);

/**
 * Get the value of a fulfilled promise.
 */
JSValue js_promise_get_fulfilled_value(JSContext *context, JSValue promise);

#endif //QJS_KT_JS_VALUE_UTIL_H
