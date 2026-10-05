#include "jni_globals.h"
#include "log_util.h"
#include "jni_globals_generated.h"
#include <pthread.h>

static JavaVM *vm = NULL;
static unsigned int instance_count = 0;
static pthread_mutex_t resources_mutex = PTHREAD_MUTEX_INITIALIZER;

void cache_java_vm(JNIEnv *env) {
    pthread_mutex_lock(&resources_mutex);
    (*env)->GetJavaVM(env, &vm);
    instance_count++;
    pthread_mutex_unlock(&resources_mutex);
}

JNIEnv *get_jni_env() {
    pthread_mutex_lock(&resources_mutex);
    JavaVM *current_vm = vm;
    pthread_mutex_unlock(&resources_mutex);
    if (current_vm == NULL) {
        log("Cannot get jni env because the vm is not cached.");
        return NULL;
    }
    JNIEnv *env = NULL;
    int attached = 0;
    jint get_env_result = (*current_vm)->GetEnv(current_vm, (void **) &env, JNI_VERSION_1_6);
    if (get_env_result == JNI_OK) {
        attached = 1;
    } else if (get_env_result == JNI_EDETACHED) {
        // Got a warning on Android Studio when casting &env to (void **)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wincompatible-pointer-types"
        if ((*current_vm)->AttachCurrentThread(current_vm, (void **) &env, NULL) == JNI_OK) {
#pragma clang diagnostic pop
            attached = 1;
        } else {
            log("Failed to attach current thread.");
        }
    } else if (get_env_result == JNI_EVERSION) {
        log("Unsupported JNI version.");
    }
    if (attached == 0) {
        return NULL;
    }
    return env;
}


// Backport upstream 4a003f6: process-wide JNI resources outlive every survivor.
void release_shared_jni_resources(JNIEnv *env) {
    pthread_mutex_lock(&resources_mutex);
    if (instance_count > 0) instance_count--;
    if (instance_count == 0) {
        vm = NULL;
        clear_jni_refs_cache(env);
    }
    pthread_mutex_unlock(&resources_mutex);
}
