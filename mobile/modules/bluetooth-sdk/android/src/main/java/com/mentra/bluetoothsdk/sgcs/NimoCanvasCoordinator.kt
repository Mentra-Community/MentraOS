package com.mentra.bluetoothsdk.sgcs

/** A cancelable clock boundary; production uses the main Handler. */
internal fun interface NimoScheduler {
    fun post(delayMs: Long, task: () -> Unit): () -> Unit
}

/** The single queue for ALL NIMO characteristic and notification-descriptor writes. */
internal class NimoGattQueue<C : Any>(
    private val scheduler: NimoScheduler,
    private val write: (C, ByteArray) -> Boolean,
    private val onFailure: (String) -> Unit,
    private val pacingMs: Long = 5,
) {
    private class Write<C>(val characteristic: C, val bytes: ByteArray,
                           val started: () -> Unit, val completed: () -> Unit) {
        var attempts = 0
        var callbackReceived = false
    }
    private val queue = ArrayDeque<Write<C>>()
    private var connection: Any? = null
    private var generation = 0L
    private var current: Write<C>? = null
    private var descriptor: Any? = null
    private var descriptorCompletion: (() -> Unit)? = null
    private var cancelDeadline: (() -> Unit)? = null

    fun connected(connection: Any) { reset(); this.connection = connection }

    fun reset() {
        generation++
        connection = null
        current = null
        descriptor = null
        descriptorCompletion = null
        queue.clear()
        cancelDeadline?.invoke()
        cancelDeadline = null
    }

    fun subscribe(connection: Any, descriptor: Any, start: () -> Boolean, completed: () -> Unit) {
        if (connection !== this.connection) return
        if (current != null || this.descriptor != null) { fail("Overlapping notification subscription"); return }
        this.descriptor = descriptor
        descriptorCompletion = completed
        if (!start()) { fail("Could not write notification descriptor"); return }
        val expected = generation
        cancelDeadline = scheduler.post(5_000) {
            if (generation == expected && this.descriptor === descriptor) fail("Notification subscription timed out")
        }
    }

    fun descriptorWritten(connection: Any, descriptor: Any, success: Boolean) {
        if (connection !== this.connection || descriptor !== this.descriptor) return
        cancelDeadline?.invoke(); cancelDeadline = null
        this.descriptor = null
        val completed = descriptorCompletion
        descriptorCompletion = null
        if (!success) { fail("Notification subscription failed"); return }
        completed?.invoke() // May install the next subscription before writes are released.
        drain()
    }

    fun enqueue(connection: Any, characteristic: C, frames: List<ByteArray>,
                finalStarted: () -> Unit = {}, completed: () -> Unit = {}): Boolean {
        if (connection !== this.connection) return false
        if (frames.isEmpty()) return false
        if (queue.size + frames.size > 1100) { fail("Fragment chain exceeds write queue budget"); return false }
        frames.forEachIndexed { index, bytes ->
            val last = index == frames.lastIndex
            queue.addLast(Write(characteristic, bytes.copyOf(), if (last) finalStarted else ({}),
                if (last) completed else ({})))
        }
        drain()
        return true
    }

    fun written(connection: Any, characteristic: C, success: Boolean) {
        val item = current ?: return
        if (connection !== this.connection || characteristic !== item.characteristic || item.callbackReceived) return
        item.callbackReceived = true
        cancelDeadline?.invoke(); cancelDeadline = null
        if (!success) { fail("GATT write failed"); return }
        val expected = generation
        scheduler.post(pacingMs) {
            if (generation != expected || current !== item) return@post
            current = null
            item.completed()
            drain()
        }
    }

    private fun drain() {
        if (connection == null || current != null || descriptor != null) return
        val item = queue.removeFirstOrNull() ?: return
        current = item
        val expected = generation
        val accepted = try { write(item.characteristic, item.bytes) } catch (_: Exception) { false }
        if (!accepted) {
            current = null
            if (++item.attempts >= 3) { fail("GATT rejected write after three attempts"); return }
            queue.addFirst(item)
            scheduler.post(100) { if (expected == generation) drain() }
            return
        }
        item.started()
        cancelDeadline = scheduler.post(3_000) {
            if (expected == generation && current === item && !item.callbackReceived) fail("GATT write timed out")
        }
    }

    private fun fail(reason: String) { reset(); onFailure(reason) }
}

/** Business ACKs cannot advance the session until their complete fragment chain was written. */
internal class NimoCanvasCoordinator(
    private val scheduler: NimoScheduler,
    private val writeCapacity: () -> Int,
    private val enqueue: (List<ByteArray>, () -> Unit, () -> Unit) -> Boolean,
    private val reconnect: (String) -> Unit,
    private val rejected: (Int) -> Unit = {},
    private val holdPreempted: () -> Unit = {},
) {
    private class Flight(val action: NimoCanvasSession.Action.Send) {
        var finalStarted = false
        var complete = false
        var earlyAck: ByteArray? = null
    }
    private val session = NimoCanvasSession()
    private var flight: Flight? = null
    private var holdReady: (() -> Unit)? = null
    private var holding = false
    private var heldScope: String? = null
    private var cancelDeadline: (() -> Unit)? = null

    fun offer(bytes: ByteArray, scope: String, force: Boolean = false) {
        if (holding && scope != heldScope) {
            releaseHold(resume = false)
            holdPreempted()
        }
        run(session.offer(bytes, scope, force))
    }
    fun readiness(ready: Boolean) = run(session.readiness(ready))
    fun confirmedReadiness(ready: Boolean) = run(session.confirmedReadiness(ready))
    fun hold(onReady: () -> Unit) {
        session.hold(true)
        holding = true
        heldScope = session.currentScope()
        holdReady = onReady
        notifyHoldReadyIfIdle()
    }
    fun releaseHold(resume: Boolean = true) {
        holdReady = null
        holding = false
        heldScope = null
        run(session.hold(false, resume))
    }
    fun exit() = run(session.exit())
    /** Whether this report also invalidates an unfinished host encode. Exit's report does not
     * invalidate a NEW scene submitted while the explicit Exit waits for its business ACK. */
    fun nativeApp(appId: Int, entered: Boolean): Boolean {
        val takeover = (appId == NimoCanvasCodec.APP_ID && !entered) ||
            (appId != NimoCanvasCodec.APP_ID && entered)
        val expectedExitReport = appId == NimoCanvasCodec.APP_ID && !entered && flight?.action?.key == 3
        val invalidateEncoding = takeover && !expectedExitReport
        run(session.nativeApp(appId, entered))
        return invalidateEncoding
    }

    fun disconnected() {
        cancelDeadline?.invoke(); cancelDeadline = null
        flight = null
        holdReady = null
        holding = false
        heldScope = null
        session.disconnected()
    }

    fun response(key: Int, payload: ByteArray) {
        val current = flight ?: return
        if (!session.acceptsResponse(key, payload)) return
        if (!current.complete) {
            if (current.finalStarted && current.earlyAck == null) current.earlyAck = payload.copyOf()
            return
        }
        cancelDeadline?.invoke(); cancelDeadline = null
        flight = null
        run(session.response(key, payload))
        notifyHoldReadyIfIdle()
    }

    private fun notifyHoldReadyIfIdle() {
        if (flight != null) return
        val ready = holdReady ?: return
        holdReady = null
        ready()
    }

    private fun run(actions: List<NimoCanvasSession.Action>) {
        for (action in actions) when (action) {
            is NimoCanvasSession.Action.Send -> {
                cancelDeadline?.invoke()
                val current = Flight(action)
                flight = current
                cancelDeadline = scheduler.post(45_000) {
                    if (flight === current) run(session.timeout(action.ticket))
                }
                val queued = enqueue(NimoCanvasCodec.frames(action.key, action.frame, writeCapacity()),
                    { if (flight === current) current.finalStarted = true },
                    {
                        if (flight === current) {
                            current.complete = true
                            current.earlyAck?.let { response(action.key, it) }
                        }
                    })
                if (!queued && flight === current) {
                    disconnected()
                    reconnect("Canvas transport unavailable")
                }
            }
            is NimoCanvasSession.Action.Reconnect -> { disconnected(); reconnect(action.reason) }
            is NimoCanvasSession.Action.Rejected -> rejected(action.status)
        }
    }
}
