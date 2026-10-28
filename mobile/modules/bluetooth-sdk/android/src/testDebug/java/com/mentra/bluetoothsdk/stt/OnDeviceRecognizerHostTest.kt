package com.mentra.bluetoothsdk.stt

import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class OnDeviceRecognizerHostTest {
    private class Recognizer(val path: String) {
        var released = false
    }

    /** Runs load jobs only when the test says so, to control interleavings. */
    private class ManualExecutor : Executor {
        val jobs = ArrayDeque<Runnable>()

        override fun execute(command: Runnable) {
            jobs.add(command)
        }

        fun runNext() = jobs.removeFirst().run()

        fun runAll() {
            while (jobs.isNotEmpty()) runNext()
        }
    }

    private var selected: OnDeviceRecognizerHost.Selection? = OnDeviceRecognizerHost.Selection("/models/en-kroko", "en-US")
    private val failing = mutableSetOf<String>()
    private val loads = mutableListOf<String>()
    private val events = mutableListOf<String>()
    private val loader = ManualExecutor()
    @Volatile private var loadStarted: CountDownLatch? = null
    @Volatile private var loadGate: CountDownLatch? = null

    private val host: OnDeviceRecognizerHost<Recognizer> =
        OnDeviceRecognizerHost(
            selection = { selected },
            loadModel = { selection ->
                loads.add(selection.path)
                loadStarted?.countDown()
                loadGate?.await(5, TimeUnit.SECONDS)
                if (selection.path in failing) throw IllegalStateException("corrupt model")
                Recognizer(selection.path)
            },
            pathMatches = { recognizer, path -> recognizer.path == path },
            release = { recognizer ->
                // The audio thread must no longer be able to reach a recognizer being released.
                assertFalse("released while still current", host().current === recognizer)
                recognizer.released = true
                events.add("release ${recognizer.path}")
            },
            loader = loader,
        )

    private fun host(): OnDeviceRecognizerHost<Recognizer> = host

    @Test
    fun gainingDemandLoadsOffTheCallingThreadAndLosingItReleases() {
        host.setDemand(true)
        assertNull("loading must not happen on the caller", host.current)
        assertTrue(loader.jobs.isNotEmpty())
        loader.runAll()

        val loaded = host.current!!
        assertEquals("/models/en-kroko", loaded.path)
        assertTrue(host.isLoaded("/models/en-kroko"))

        host.setDemand(false)
        assertNull(host.current)
        assertTrue(loaded.released)
        assertFalse(host.isLoaded("/models/en-kroko"))
    }

    @Test
    fun restartWithoutDemandResolvesImmediatelyWithoutLoading() {
        val result = host.restart()
        assertTrue(result.isDone)
        result.get()
        assertTrue(loader.jobs.isEmpty())
        assertTrue(loads.isEmpty())
    }

    @Test
    fun restartJoinsTheLoadAlreadyInFlight() {
        host.setDemand(true)
        val result = host.restart()
        assertFalse(result.isDone)
        loader.runAll()
        result.get()
        assertEquals(listOf("/models/en-kroko"), loads)
    }

    @Test
    fun restartWithTheLoadedModelDoesNotReload() {
        host.setDemand(true)
        loader.runAll()
        val result = host.restart()
        assertTrue(result.isDone)
        assertEquals(1, loads.size)
    }

    @Test
    fun restartSwapsInTheNewModelThenReleasesTheOldOne() {
        host.setDemand(true)
        loader.runAll()
        val old = host.current!!

        selected = OnDeviceRecognizerHost.Selection("/models/fr", "fr-FR")
        val result = host.restart()
        assertSame("the old model keeps serving audio while the new one loads", old, host.current)
        loader.runAll()
        result.get()

        assertEquals("/models/fr", host.current!!.path)
        assertTrue(old.released)
        assertEquals(listOf("release /models/en-kroko"), events)
    }

    @Test
    fun failedRestartRejectsAndDoesNotKeepAModelThatIsNoLongerSelected() {
        host.setDemand(true)
        loader.runAll()
        val old = host.current!!

        selected = OnDeviceRecognizerHost.Selection("/models/de", "de-DE")
        failing.add("/models/de")
        val result = host.restart()
        loader.runAll()
        try {
            result.get()
            fail("restart should fail")
        } catch (error: ExecutionException) {
            assertEquals("corrupt model", error.cause!!.message)
        }
        assertNull(host.current)
        assertTrue(old.released)

        // The next attempt retries the load.
        failing.clear()
        val retry = host.restart()
        loader.runAll()
        retry.get()
        assertEquals("/models/de", host.current!!.path)
    }

    @Test
    fun demandEndingDuringALoadDiscardsTheResult() {
        host.setDemand(true)
        val result = host.restart()
        host.setDemand(false)
        assertTrue("a waiting restart resolves once there is no demand", result.isDone)
        result.get()

        loader.runAll()
        assertNull(host.current)
        assertTrue(loads.isEmpty() || events.contains("release /models/en-kroko"))
    }

    @Test
    fun aLoadThatFinishesAfterDemandEndedIsReleasedNotSwappedIn() {
        loadStarted = CountDownLatch(1)
        loadGate = CountDownLatch(1)
        host.setDemand(true)
        val job = loader.jobs.removeFirst()
        val running = Thread { job.run() }
        running.start()
        assertTrue(loadStarted!!.await(5, TimeUnit.SECONDS))

        // Demand ends while the model is still loading.
        host.setDemand(false)
        loadGate!!.countDown()
        running.join(5_000)

        assertNull(host.current)
        assertEquals(listOf("/models/en-kroko"), loads)
        assertEquals(listOf("release /models/en-kroko"), events)
    }

    @Test
    fun aSupersededRestartFollowsTheNewerLoad() {
        host.setDemand(true)
        loader.runAll()
        selected = OnDeviceRecognizerHost.Selection("/models/fr", "fr-FR")
        val first = host.restart()
        selected = OnDeviceRecognizerHost.Selection("/models/es", "es-ES")
        val second = host.restart()
        loader.runAll()
        second.get()
        first.get()
        assertEquals("/models/es", host.current!!.path)
        // The superseded French load never ran or was released.
        assertFalse(host.isLoaded("/models/fr"))
    }

    @Test
    fun noSelectedModelRejectsRestart() {
        selected = null
        host.setDemand(true)
        assertTrue(loader.jobs.isEmpty())
        try {
            host.restart().get()
            fail("restart should fail without a model")
        } catch (error: ExecutionException) {
            assertTrue(error.cause is IllegalStateException)
        }
    }
}
