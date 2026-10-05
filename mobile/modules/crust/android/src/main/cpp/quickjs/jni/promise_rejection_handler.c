#include <jni.h>
#include "promise_rejection_handler.h"
#include "jni_globals.h"
#include "jni_globals_generated.h"
#include "js_value_to_jobject.h"

void promise_rejection_handler(JSContext *ctx, JSValue promise,
                               JSValue reason,
                               int is_handled, void *opaque) {
    JNIEnv *env = get_jni_env();
    if (env == NULL) {
        return;
    }
    jobject host = (jobject) opaque;
    if (!is_handled) {
        (*env)->CallVoidMethod(env, host,
                               method_quick_js_set_unhandled_promise_rejection(env),
                               js_value_to_jobject(env, ctx, reason));
    }
}
