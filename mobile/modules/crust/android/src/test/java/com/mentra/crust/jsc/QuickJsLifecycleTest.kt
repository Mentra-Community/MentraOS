package com.mentra.crust.jsc

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.QuickJsException
import com.dokar.quickjs.binding.function
import java.util.concurrent.Executors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

/**
 * Runs the real QuickJS JNI library (through the desktop JVM artifact, see
 * build.gradle) the way [JSCRuntime] uses it: one instance per miniapp, Kotlin
 * bindings called from JS, and independent close orders.
 */
class QuickJsLifecycleTest {
    private fun create() = QuickJs.create(Dispatchers.Unconfined)

    @Test fun `closing one instance keeps another instance's callbacks working`() = runBlocking {
        var calls = 0
        val survivor = create()
        survivor.function("hostCallback") { calls++; 42 }
        val other = create()
        assertEquals(42, survivor.evaluate<Int>("hostCallback()"))
        other.close()
        withTimeout(1000) { assertEquals(42, survivor.evaluate<Int>("hostCallback()")) }
        assertEquals(2, calls)
        repeat(20) {
            create().close()
            assertEquals(42, survivor.evaluate<Int>("hostCallback()"))
        }
        val workers = Executors.newFixedThreadPool(4)
        try {
            (1..40).map { workers.submit { create().close() } }.forEach { it.get() }
            assertEquals(42, survivor.evaluate<Int>("hostCallback()"))
        } finally {
            workers.shutdownNow()
        }
        survivor.close()
        val fresh = create()
        fresh.function("hostCallback") { 7 }
        assertEquals(7, fresh.evaluate<Int>("hostCallback()"))
        fresh.close()
        val older = create()
        val newer = create()
        newer.function("hostCallback") { 9 }
        older.close()
        assertEquals(9, newer.evaluate<Int>("hostCallback()"))
        newer.close()
    }

    @Test fun `a binding exception is a catchable JS Error carrying the message`() = runBlocking {
        val qjs = create()
        qjs.function("__dispatch") { throw MentraJSDispatchError("INVALID_ARGS", "iface") }
        val caught = qjs.evaluate<String>(
            "try { __dispatch(); 'no throw' } catch (e) { (e instanceof Error) + '|' + e.message }",
        )
        assertEquals("true|INVALID_ARGS: iface", caught)
        qjs.close()
    }

    @Test fun `non-ASCII strings cross the bridge unchanged`() = runBlocking {
        val text = "héllo 😀 中文 \u0000 end"
        var received: String? = null
        val qjs = create()
        qjs.function("hostText") { text }
        qjs.function("hostEcho") { args -> received = args[0] as String; args[0] }
        assertEquals(text, qjs.evaluate<String>("hostEcho(hostText())"))
        assertEquals(text, received)
        qjs.close()
    }

    @Test fun `unusual thrown values fail as exceptions, not crashes`() = runBlocking {
        val qjs = create()
        for (source in listOf("throw undefined", "throw null", "throw new Error('%s%n%s%n')")) {
            try {
                qjs.evaluate<Any?>(source)
                fail("$source did not throw")
            } catch (_: QuickJsException) {
            }
            assertEquals(2, qjs.evaluate<Int>("1 + 1"))
        }
        qjs.close()
    }
}
