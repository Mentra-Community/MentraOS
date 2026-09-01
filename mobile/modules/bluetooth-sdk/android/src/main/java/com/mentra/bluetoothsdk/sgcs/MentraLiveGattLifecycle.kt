package com.mentra.bluetoothsdk.sgcs

/**
 * Process-wide barrier between Mentra Live GATT teardown and the next connection attempt.
 *
 * Android can keep the physical link alive after a disconnect request until it delivers the
 * disconnected callback. Starting another GATT session before that callback can reuse the old link,
 * including its already-consumed MTU exchange. Callers queue connection work here and release it
 * only after every outstanding teardown has completed or timed out.
 */
internal class MentraLiveGattTeardownBarrier {
    private val activeTeardowns = mutableSetOf<Long>()
    private val waitingConnections = ArrayDeque<() -> Unit>()
    private var nextToken = 1L

    @Synchronized
    fun beginTeardown(): Long {
        val token = nextToken++
        activeTeardowns.add(token)
        return token
    }

    /** Returns true when [work] was deferred behind an active teardown. */
    @Synchronized
    fun deferUntilIdle(work: () -> Unit): Boolean {
        if (activeTeardowns.isEmpty()) {
            return false
        }
        waitingConnections.addLast(work)
        return true
    }

    fun completeTeardown(token: Long) {
        val ready =
            synchronized(this) {
                if (!activeTeardowns.remove(token) || activeTeardowns.isNotEmpty()) {
                    return
                }
                buildList {
                    while (waitingConnections.isNotEmpty()) {
                        add(waitingConnections.removeFirst())
                    }
                }
            }
        ready.forEach { it() }
    }
}

/** One-shot guard shared by the MTU callback and its watchdog fallback. */
internal class MentraLiveMtuSetupGate {
    private var nextToken = 1L
    private var pendingToken: Long? = null

    @Synchronized
    fun begin(): Long {
        val token = nextToken++
        pendingToken = token
        return token
    }

    /** Returns true exactly once for the current setup operation. */
    @Synchronized
    fun complete(token: Long): Boolean {
        if (pendingToken != token) {
            return false
        }
        pendingToken = null
        return true
    }

    @Synchronized
    fun cancel() {
        pendingToken = null
    }
}
