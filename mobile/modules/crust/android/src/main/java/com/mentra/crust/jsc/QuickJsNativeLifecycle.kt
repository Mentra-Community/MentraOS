package com.mentra.crust.jsc

/**
 * quickjs-kt 1.0.15 keeps one process-wide JavaVM and an instance counter.
 * Neither update is atomic. Two miniapps creating or closing at the same time
 * can drop that VM while another context is still open, and the next call
 * logs "Cannot get jni env because the vm is not cached".
 *
 * Every [com.dokar.quickjs.QuickJs.create] and [com.dokar.quickjs.QuickJs.close]
 * in this process goes through [withNative]. Evaluation stays outside the lock.
 */
internal object QuickJsNativeLifecycle {
    private val lock = Any()

    fun <T> withNative(block: () -> T): T = synchronized(lock) { block() }
}
