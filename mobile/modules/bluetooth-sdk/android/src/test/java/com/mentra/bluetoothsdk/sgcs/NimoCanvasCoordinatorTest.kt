package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.*
import org.junit.Test

class NimoCanvasCoordinatorTest {
    private class Clock : NimoScheduler {
        private data class Job(val time: Long, val task: () -> Unit, var canceled: Boolean = false)
        private var now = 0L
        private val jobs = mutableListOf<Job>()
        override fun post(delayMs: Long, task: () -> Unit): () -> Unit {
            val job = Job(now + delayMs, task)
            jobs += job
            return { job.canceled = true }
        }
        fun advance(ms: Long) {
            val end = now + ms
            while (true) {
                val job = jobs.filter { it.time <= end }.minByOrNull { it.time } ?: break
                jobs.remove(job); now = job.time
                if (!job.canceled) job.task()
            }
            now = end
        }
    }

    private class Fixture {
        val clock = Clock()
        var connection: Any = Any()
        val characteristic = Any()
        val writes = mutableListOf<ByteArray>()
        val failures = mutableListOf<String>()
        val rejections = mutableListOf<Int>()
        var holdPreemptions = 0
        var rejectWrites = false
        val queue = NimoGattQueue<Any>(clock, { _, bytes -> writes += bytes; !rejectWrites }, { failures += it })
        val canvas = NimoCanvasCoordinator(clock, { 20 },
            { frames, started, completed -> queue.enqueue(connection, characteristic, frames, started, completed) },
            { queue.reset(); failures += it }, { rejections += it }, { holdPreemptions++ })
        init { queue.connected(connection) }
        fun written(success: Boolean = true) {
            queue.written(connection, characteristic, success)
            clock.advance(5)
        }
        fun ack(key: Int, status: Int = 0) = canvas.response(key, if (status != 0) byteArrayOf(status.toByte())
            else if (key == 4) byteArrayOf(0, 0xFD.toByte(), 0, 0, 0) else byteArrayOf(0, 0xFD.toByte()))
        fun launch(frame: ByteArray = byteArrayOf(0, 0, 1)) {
            canvas.offer(frame, "one:1"); canvas.readiness(true)
            written(); ack(1)
        }
        fun finishUpdate(frame: ByteArray) { repeat(NimoCanvasCodec.frames(4, frame, 20).size) { written() }; ack(4) }
    }

    @Test fun bothNotificationDescriptorsGateCharacteristicWrites() {
        val f = Fixture()
        val rx = Any(); val mic = Any()
        val subscribed = mutableListOf<String>()
        f.queue.subscribe(f.connection, rx, { subscribed += "rx"; true }) {
            f.queue.subscribe(f.connection, mic, { subscribed += "mic"; true }) {}
        }
        f.canvas.offer(byteArrayOf(0, 0, 1), "one"); f.canvas.readiness(true)
        assertTrue(f.writes.isEmpty())
        f.queue.descriptorWritten(f.connection, Any(), true)
        assertTrue(f.writes.isEmpty())
        f.queue.descriptorWritten(f.connection, rx, true)
        assertEquals(listOf("rx", "mic"), subscribed)
        assertTrue(f.writes.isEmpty())
        f.queue.descriptorWritten(f.connection, mic, true)
        assertEquals(1, f.writes.size)
    }

    @Test fun entireFragmentChainRemainsContiguousAmongOtherCommands() {
        val f = Fixture()
        val frame = ByteArray(85) { it.toByte() }
        f.launch(frame)
        val update = NimoCanvasCodec.frames(4, frame, 20)
        val other = byteArrayOf(42)
        f.queue.enqueue(f.connection, f.characteristic, listOf(other))
        repeat(update.size) { f.written() }
        assertEquals(update.size + 2, f.writes.size)
        update.forEachIndexed { i, bytes -> assertArrayEquals(bytes, f.writes[i + 1]) }
        assertArrayEquals(other, f.writes.last())
    }

    @Test fun earlyAndDuplicateAcksCannotReleaseAnUnfinishedChain() {
        val f = Fixture()
        val a = ByteArray(60) { it.toByte() }; val b = byteArrayOf(0, 0, 1)
        f.launch(a)
        f.canvas.offer(b, "one:1")
        f.ack(4) // Before the final fragment has started: stale/uncorrelated.
        val fragments = NimoCanvasCodec.frames(4, a, 20).size
        repeat(fragments - 1) { f.written() }
        val before = f.writes.size
        f.ack(4) // Final fragment started, but its callback has not completed.
        f.ack(4, 6) // Duplicate must not replace the first valid early ACK.
        assertEquals(before, f.writes.size)
        f.queue.written(f.connection, f.characteristic, true)
        f.queue.written(f.connection, f.characteristic, true) // Duplicate callback within pacing window.
        assertEquals(before, f.writes.size)
        f.clock.advance(5)
        assertEquals(before + 1, f.writes.size)
        assertTrue(f.rejections.isEmpty())
        f.finishUpdate(b)
        f.ack(4) // Late duplicate with no business command in flight.
        assertTrue(f.failures.isEmpty())
    }

    @Test fun finalCallbackFailureAndMissingCallbackNeverReleaseNextFragment() {
        for (missing in listOf(false, true)) {
            val f = Fixture(); f.launch(ByteArray(60))
            val before = f.writes.size
            if (missing) f.clock.advance(3_000) else f.written(false)
            assertEquals(before, f.writes.size)
            assertEquals(1, f.failures.size)
            f.queue.written(f.connection, f.characteristic, true)
            f.clock.advance(5)
            assertEquals(before, f.writes.size)
        }
    }

    @Test fun writeStartRetriesAreBoundedAndDescriptorFailuresReset() {
        val f = Fixture(); f.rejectWrites = true
        f.canvas.offer(byteArrayOf(0, 0, 1), "one"); f.canvas.readiness(true)
        f.clock.advance(200)
        assertEquals(3, f.writes.size)
        assertEquals(1, f.failures.size)
        for (failure in listOf("start", "callback", "missing")) {
            val link = Fixture(); val descriptor = Any()
            link.queue.subscribe(link.connection, descriptor, { failure != "start" }) { fail("Must not become ready") }
            if (failure == "callback") link.queue.descriptorWritten(link.connection, descriptor, false)
            if (failure == "missing") link.clock.advance(5_000)
            assertEquals(1, link.failures.size)
        }
    }

    @Test fun ackDeadlineResetsAndReplacedConnectionCallbacksAreIgnored() {
        val f = Fixture(); f.launch()
        f.written() // Update is transported, but no business ACK.
        f.clock.advance(45_000)
        assertEquals(1, f.failures.size)
        f.ack(4)
        val old = f.connection
        f.connection = Any(); f.queue.connected(f.connection)
        f.canvas.readiness(true)
        val before = f.writes.size
        f.queue.written(old, f.characteristic, true)
        f.clock.advance(5)
        assertEquals(before, f.writes.size)
        f.written(); f.ack(1); f.finishUpdate(byteArrayOf(0, 0, 1))
        assertEquals(1, f.failures.size)
    }

    @Test fun rejectedUpdateImmediatelyDrainsDifferentQueuedScene() {
        val f = Fixture(); f.launch()
        f.written()
        val b = byteArrayOf(1, 0, 1)
        f.canvas.offer(b, "one:1")
        val before = f.writes.size
        f.ack(4, 6)
        assertEquals(listOf(6), f.rejections)
        assertEquals(before + 1, f.writes.size)
        assertArrayEquals(NimoCanvasCodec.frames(4, b, 20).first(), f.writes.last())
    }

    @Test fun confirmedReadinessRelaunchesAfterNotReadyAndPreservesLatestScene() {
        val f = Fixture(); f.launch(); f.written()
        f.ack(4, 7)
        val b = byteArrayOf(1, 0, 1)
        f.canvas.offer(b, "one:1")
        val before = f.writes.size
        f.canvas.readiness(true)
        assertEquals(before, f.writes.size)
        f.canvas.confirmedReadiness(true)
        assertEquals(before + 1, f.writes.size)
        assertArrayEquals(NimoCanvasCodec.frames(1, writeCapacity = 20).single(), f.writes.last())
        f.written(); f.ack(1)
        assertArrayEquals(NimoCanvasCodec.frames(4, b, 20).single(), f.writes.last())
        f.finishUpdate(b)
        assertEquals(listOf(7), f.rejections)
        assertTrue(f.failures.isEmpty())
    }

    @Test fun newerSceneSurvivesExitReportAndWaitsForExitAck() {
        val f = Fixture(); f.launch(); f.finishUpdate(byteArrayOf(0, 0, 1))
        f.canvas.exit()
        f.canvas.offer(byteArrayOf(1, 0, 1), "two:1")
        assertFalse(f.canvas.nativeApp(0xFD, false))
        f.written()
        val before = f.writes.size
        f.ack(3)
        assertEquals(before + 1, f.writes.size)
        assertArrayEquals(NimoCanvasCodec.frames(1, writeCapacity = 20).single(), f.writes.last())
    }

    @Test fun actualNativeTakeoverDuringExitInvalidatesEncodingAndDoesNotRelaunch() {
        val f = Fixture(); f.launch(); f.finishUpdate(byteArrayOf(0, 0, 1))
        f.canvas.exit()
        f.canvas.offer(byteArrayOf(1, 0, 1), "two:1")
        assertTrue(f.canvas.nativeApp(0, true))
        f.written()
        val before = f.writes.size
        f.ack(3)
        assertEquals(before, f.writes.size)
        assertTrue(f.failures.isEmpty())
    }

    @Test fun diagnosticHoldWaitsForCurrentBusinessAckAndThenResumesLatestScene() {
        val f = Fixture()
        val initial = byteArrayOf(0, 0, 1)
        val latest = byteArrayOf(2, 0, 1)
        f.launch(initial)
        var ready = 0
        f.canvas.hold { ready++ }
        f.canvas.offer(byteArrayOf(1, 0, 1), "one:1")
        f.canvas.offer(latest, "one:1")

        assertEquals(0, ready)
        f.finishUpdate(initial)
        assertEquals(1, ready)
        val beforeRelease = f.writes.size

        f.canvas.releaseHold()

        assertEquals(beforeRelease + 1, f.writes.size)
        assertArrayEquals(NimoCanvasCodec.frames(4, latest, 20).first(), f.writes.last())
    }

    @Test fun scopeTakeoverPreemptsHoldWithoutFlushingHeldScene() {
        val f = Fixture()
        val initial = byteArrayOf(0, 0, 1)
        val held = byteArrayOf(1, 0, 1)
        val takeover = byteArrayOf(2, 0, 1)
        f.launch(initial); f.finishUpdate(initial)
        var ready = 0
        f.canvas.hold { ready++ }
        f.canvas.offer(held, "one:1")
        val beforeTakeover = f.writes.size

        f.canvas.offer(takeover, "two:1")

        assertEquals(1, ready)
        assertEquals(1, f.holdPreemptions)
        assertEquals(beforeTakeover + 1, f.writes.size)
        assertArrayEquals(NimoCanvasCodec.frames(4, takeover, 20).first(), f.writes.last())
    }

    @Test fun firstScopePreemptsHoldAcquiredBeforeAnyCanvasScene() {
        val f = Fixture()
        var ready = 0
        f.canvas.readiness(true)
        f.canvas.hold { ready++ }
        assertEquals(1, ready)

        f.canvas.offer(byteArrayOf(0, 0, 1), "first:1")

        assertEquals(1, f.holdPreemptions)
        assertEquals(1, f.writes.size)
        assertArrayEquals(NimoCanvasCodec.frames(1, writeCapacity = 20).single(), f.writes.single())
    }

    @Test fun reentrantCompletionCannotReleaseNewConnectionWrite() {
        val f = Fixture(); val old = f.connection
        f.queue.enqueue(old, f.characteristic, listOf(byteArrayOf(1)), completed = {
            f.queue.reset()
            f.connection = Any(); f.queue.connected(f.connection)
            f.queue.enqueue(f.connection, f.characteristic, listOf(byteArrayOf(2), byteArrayOf(3)))
        })
        f.written()
        assertEquals(2, f.writes.size)
        f.queue.written(old, f.characteristic, true)
        f.clock.advance(5)
        assertEquals(2, f.writes.size)
        f.written()
        assertEquals(3, f.writes.size)
        assertArrayEquals(byteArrayOf(3), f.writes.last())
    }

    @Test fun staleEncodeAfterNewSceneExitDisconnectOrDisposalCannotDeliver() {
        for (invalidate in listOf("new", "exit", "disconnect", "dispose")) {
            val main = Clock(); val worker = Clock()
            val delivered = mutableListOf<Int>(); var releases = 0; var stopped = 0
            val encoder = NimoCanvasEncoder(main, worker, { stopped++ }, { throw it })
            encoder.submit({ byteArrayOf(1) }, { releases++ }) { delivered += it[0].toInt() }
            worker.advance(0) // Completed encoding is now pending on Main.
            when (invalidate) {
                "new" -> encoder.submit({ byteArrayOf(2) }, { releases++ }) { delivered += it[0].toInt() }
                "dispose" -> encoder.close()
                else -> encoder.invalidate()
            }
            worker.advance(0); main.advance(0)
            assertEquals(if (invalidate == "new") listOf(2) else emptyList(), delivered)
            encoder.close(); encoder.close()
            assertEquals(1, stopped)
            assertEquals(if (invalidate == "new") 2 else 1, releases)
        }
    }

    @Test fun canceledAndDisposedBitmapSourcesAreReleasedExactlyOnce() {
        val main = Clock(); val worker = Clock(); var encoded = 0; var released = 0
        val encoder = NimoCanvasEncoder(main, worker, {}, { throw it })
        encoder.submit({ encoded++; byteArrayOf(1) }, { released++ }) { fail("Canceled work delivered") }
        encoder.invalidate(); worker.advance(0); main.advance(0)
        assertEquals(0, encoded); assertEquals(1, released)
        encoder.close()
        assertFalse(encoder.submit({ encoded++; byteArrayOf(2) }, { released++ }) {})
        assertEquals(0, encoded); assertEquals(2, released)
    }
}
