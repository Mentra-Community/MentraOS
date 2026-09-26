package com.mentra.bluetoothsdk.sgcs

/** Owns latest-only background work, including resources belonging to canceled bitmap requests. */
internal class NimoCanvasEncoder(
    private val main: NimoScheduler,
    private val worker: NimoScheduler,
    private val stopWorker: () -> Unit,
    private val failed: (Exception) -> Unit,
) {
    private class Request(val generation: Long, val encode: () -> ByteArray,
                          val release: () -> Unit, val deliver: (ByteArray) -> Unit) {
        var cancel: (() -> Unit)? = null
    }
    private var generation = 0L
    private var pending: Request? = null
    private var closed = false

    @Synchronized
    fun submit(encode: () -> ByteArray, release: () -> Unit = {}, deliver: (ByteArray) -> Unit): Boolean {
        if (closed) { release(); return false }
        invalidate()
        val request = Request(generation, encode, release, deliver)
        pending = request
        request.cancel = worker.post(0) { encode(request) }
        return true
    }

    @Synchronized
    fun invalidate() {
        generation++
        pending?.let { it.cancel?.invoke(); it.release() }
        pending = null
    }

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        invalidate()
        stopWorker()
    }

    private fun encode(request: Request) {
        synchronized(this) {
            if (pending !== request) return
            pending = null // Running work releases its own source, never the invalidator.
        }
        try {
            val bytes = request.encode()
            main.post(0) {
                synchronized(this) {
                    if (!closed && generation == request.generation) request.deliver(bytes)
                }
            }
        } catch (error: Exception) { failed(error) }
        finally { request.release() }
    }
}
