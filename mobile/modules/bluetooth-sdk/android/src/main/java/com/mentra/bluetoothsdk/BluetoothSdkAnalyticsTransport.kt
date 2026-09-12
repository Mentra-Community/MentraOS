package com.mentra.bluetoothsdk

import android.content.Context
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Process-wide owner of analytics delivery: one serial executor and one retry
 * queue for the whole process. Connection tracking stays per SDK instance, but
 * two instances can overlap briefly when the SDK is recreated, and if each
 * owned its own executor a drain started by the old instance could rewrite the
 * retry file over an event the new instance had just persisted. A single
 * executor serializes every read-modify-write of that file.
 */
internal object BluetoothSdkAnalyticsTransport {
    private val executor: ExecutorService =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "MentraBluetoothSdkAnalytics").apply { isDaemon = true }
        }

    @Volatile
    private var queue: BluetoothSdkAnalyticsQueue? = null

    fun queue(context: Context): BluetoothSdkAnalyticsQueue =
        queue ?: synchronized(this) {
            queue ?: BluetoothSdkAnalyticsQueue(File(context.applicationContext.filesDir, BluetoothSdkAnalyticsQueue.FILE_NAME))
                .also { queue = it }
        }

    /** Runs [block] on the transport executor; analytics must never affect SDK behavior. */
    fun submit(block: () -> Unit) {
        try {
            executor.execute {
                try {
                    block()
                } catch (_: Exception) {
                }
            }
        } catch (_: RejectedExecutionException) {
        }
    }

    /** Test hook: waits until every task submitted so far has run. */
    internal fun awaitIdle() {
        executor.submit {}.get()
    }
}
