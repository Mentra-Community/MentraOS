#include <stdlib.h>
#include <string.h>
#include "js_value_util.h"
#include "log_util.h"

char *js_array_join(JSContext *context, JSValue array, const char *separator) {
    if (!JS_IsArray(context, array) || separator == NULL) {
        return NULL;
    }

    JSValue js_len = JS_GetPropertyStr(context, array, "length");
    int64_t length;
    JS_ToInt64(context, &length, js_len);
    JS_FreeValue(context, js_len);

    if (length < 0) {
        fprintf(stderr, "Failed to get array length\n");
        return NULL;
    }

    if (length == 0) {
        char *str = malloc(1);
        str[0] = '\0';
        return str;
    }

    char **parts = malloc(sizeof(char *) * length);

    size_t separator_len = strlen(separator);
    size_t total_len = 0;

    for (int i = 0; i < length; i++) {
        JSValue element = JS_GetPropertyUint32(context, array, i);
        size_t len;
        const char *line = JS_ToCStringLen(context, &len, element);
        parts[i] = malloc(len + 1);
        strcpy(parts[i], line);
        JS_FreeCString(context, line);
        JS_FreeValue(context, element);
        total_len += len;
        if (i != length - 1) {
            total_len += separator_len;
        }
    }

    char *result = (char *) malloc(total_len + 1);
    if (result == NULL) {
        fprintf(stderr, "Memory allocation failed\n");
        return NULL;
    }

    size_t position = 0;
    for (int i = 0; i < length; ++i) {
        strcpy(result + position, parts[i]);
        position += strlen(parts[i]);
        if (i != length - 1) {
            strcpy(result + position, separator);
            position += separator_len;
        }
        free(parts[i]);
    }

    result[position] = '\0';

    return result;
}

void js_error_to_string(JSContext *context, JSValue error, char **out) {
    // Get name
    JSValue js_name = JS_GetPropertyStr(context, error, "name");

    if (JS_IsUndefined(js_name)) {
        // Could be arbitrary types
        const char *c_str = JS_ToCString(context, error);
        const char *str = c_str != NULL ? c_str : "<UNSUPPORTED_ERROR>";
        char *copy = malloc(strlen(str) + 1);
        strcpy(copy, str);
        *out = copy;
        if (c_str != NULL) {
            JS_FreeCString(context, c_str);
        }
        JS_FreeValue(context, js_name);
        return;
    }

    const char *c_name = JS_ToCString(context, js_name);
    const char *name = c_name != NULL ? c_name : "<UNKNOWN_ERROR>";

    // Get message
    JSValue js_message = JS_GetPropertyStr(context, error, "message");
    const char *c_message = JS_ToCString(context, js_message);
    const char *message = c_message != NULL ? c_message : "<NO_MESSAGE>";

    int name_len = strlen(name);
    int msg_len = strlen(message);

    // Get stack trace
    JSAtom stack_atom = JS_NewAtom(context, "stack");
    JSValue stack = JS_GetProperty(context, error, stack_atom);
    JS_FreeAtom(context, stack_atom);
    if (!JS_IsUndefined(stack)) {
        char *joined = js_array_join(context, stack, "\n");
        const char *stack_str = joined != NULL ? joined : JS_ToCString(context, stack);

        char *full_message = (char *) malloc(name_len + msg_len + strlen(stack_str) + 4);
        sprintf(full_message, "%s: %s\n%s", name, message, stack_str);

        // Free
        if (joined != NULL) {
            free((void *) stack_str);
        } else {
            JS_FreeCString(context, stack_str);
        }

        *out = full_message;
    } else {
        char *str = (char *) malloc(name_len + msg_len + 3);
        sprintf(str, "%s: %s", name, message);
        *out = str;
    }

    if (c_name != NULL) {
        JS_FreeCString(context, c_name);
    }
    if (c_message != NULL) {
        JS_FreeCString(context, c_message);
    }
    JS_FreeValue(context, js_name);
    JS_FreeValue(context, js_message);
    JS_FreeValue(context, stack);
}

JSValue new_simple_js_error(JSContext *context, const char *message) {
    return new_js_error(context, "Error", message, 0, NULL);
}

JSValue new_js_error(JSContext *context,
                     const char *name,
                     const char *message,
                     uint32_t stack_trace_lines,
                     const char **stack_trace) {
    JSValue error = JS_NewError(context);

    JSValue js_name = JS_NewString(context, name);
    JS_SetPropertyStr(context, error, "name", js_name);

    const char *msg = message != NULL ? message : "";
    JSValue js_message = JS_NewString(context, msg);
    JS_SetPropertyStr(context, error, "message", js_message);

    if (stack_trace_lines > 0 && stack_trace != NULL) {
        uint32_t stack_len = 0;
        for (int i = 0; i < stack_trace_lines; i++) {
            stack_len += strlen(stack_trace[i]) + 1;
        }
        char stack[stack_len + 1];
        stack[0] = '\0';
        for (int i = 0; i < stack_trace_lines; i++) {
            strcat(stack, stack_trace[i]);
            strcat(stack, "\n");
        }
        JSValue js_stack = JS_NewString(context, stack);
        JS_SetPropertyStr(context, error, "stack", js_stack);
    }

    return error;
}

int js_is_instance_of(JSContext *context, JSValue global_this, JSValue value,
                      const char *constructor_name) {
    JSValue constructor = JS_GetPropertyStr(context, global_this, constructor_name);
    if (JS_IsUndefined(constructor)) {
        JS_FreeValue(context, constructor);
        return 0;
    }
    int result = JS_IsInstanceOf(context, value, constructor);
    JS_FreeValue(context, constructor);
    return result;
}

int js_is_promise(JSContext *context, JSValue value) {
    JSValue global_this = JS_GetGlobalObject(context);
    int result = js_is_promise_2(context, global_this, value);
    JS_FreeValue(context, global_this);
    return result;
}

int js_is_promise_2(JSContext *context, JSValue global_this, JSValue value) {
    return js_is_instance_of(context, global_this, value, "Promise");
}

int js_is_uint8array(JSContext *context, JSValue global_this, JSValue value) {
    return js_is_instance_of(context, global_this, value, "Uint8Array");
}

int js_is_int8array(JSContext *context, JSValue global_this, JSValue value) {
    return js_is_instance_of(context, global_this, value, "Int8Array");
}

int js_is_set(JSContext *context, JSValue global_this, JSValue value) {
    return js_is_instance_of(context, global_this, value, "Set");
}

int js_is_map(JSContext *context, JSValue global_this, JSValue value) {
    return js_is_instance_of(context, global_this, value, "Map");
}

JSValue js_promise_get_fulfilled_value(JSContext *context, JSValue promise) {
    JSValue result = JS_PromiseResult(context, promise);
    JSValue value = JS_GetPropertyStr(context, result, "value");
    JS_FreeValue(context, result);
    return value;
}
