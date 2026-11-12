package com.mentra.bluetoothsdk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class BesCrashReportWaitersTest {
    private val keyA = "ML395018B-dump-0000002a-1f2e3d4c"
    private val keyB = "ML395018B-reset-9f3a0c1b2d4e5f60"

    private fun ack(key: String, reportId: String?, ok: Boolean, error: String? = null): Map<String, Any> =
        buildMap {
            put("type", "bes_crash_reported_ack")
            put("incidentKey", key)
            reportId?.let { put("reportId", it) }
            put("ok", ok)
            error?.let { put("error", it) }
        }

    private suspend fun expectCode(code: String, block: suspend () -> Unit): BluetoothSdkException {
        try {
            block()
        } catch (error: BluetoothSdkException) {
            assertEquals(code, error.code)
            return error
        }
        fail("expected $code")
        throw AssertionError()
    }

    @Test fun `ack delivered during send resolves the call`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        waiters.await(keyA, "rep_1", 1_000) { waiters.onAck(ack(keyA, "rep_1", ok = true)) }
    }

    @Test fun `concurrent incidents settle only their own call`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        val sentA = CompletableDeferred<Unit>()
        val sentB = CompletableDeferred<Unit>()
        val a = async { waiters.await(keyA, "rep_a", 2_000) { sentA.complete(Unit) } }
        val b = async { runCatching { waiters.await(keyB, "rep_b", 300) { sentB.complete(Unit) } } }
        sentA.await()
        sentB.await()
        assertEquals(1, waiters.onAck(ack(keyA, "rep_a", ok = true)))
        a.await()
        val bResult = b.await()
        assertEquals("request_timeout", (bResult.exceptionOrNull() as BluetoothSdkException).code)
    }

    @Test fun `ack for another reportId of the same incident is ignored`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        expectCode("request_timeout") {
            waiters.await(keyA, "rep_new", 200) {
                assertEquals(0, waiters.onAck(ack(keyA, "rep_old", ok = true)))
            }
        }
        Unit
    }

    @Test fun `ok false rejects with the glasses error`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        val error = expectCode("bes_crash_report_rejected") {
            waiters.await(keyA, "rep_1", 1_000) {
                waiters.onAck(ack(keyA, "rep_1", ok = false, error = "unknown_incident"))
            }
        }
        assertTrue(error.message!!.contains("unknown_incident"))
    }

    @Test fun `ok false without reportId rejects every call for that incident only`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        val sent = CompletableDeferred<Unit>()
        val other = async { runCatching { waiters.await(keyB, "rep_b", 300) { sent.complete(Unit) } } }
        sent.await()
        expectCode("bes_crash_report_rejected") {
            waiters.await(keyA, "rep_1", 1_000) {
                assertEquals(1, waiters.onAck(ack(keyA, null, ok = false, error = "unknown_incident")))
            }
        }
        assertEquals("request_timeout", (other.await().exceptionOrNull() as BluetoothSdkException).code)
    }

    @Test fun `ok true without reportId does not resolve`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        expectCode("request_timeout") {
            waiters.await(keyA, "rep_1", 200) { assertEquals(0, waiters.onAck(ack(keyA, null, ok = true))) }
        }
        Unit
    }

    @Test fun `disconnect rejects pending calls`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        expectCode("glasses_not_connected") {
            waiters.await(keyA, "rep_1", 5_000) {
                waiters.rejectAll(BluetoothSdkException("glasses_not_connected", "disconnected"))
            }
        }
        Unit
    }

    @Test fun `send failure propagates and leaves no waiter behind`() = runBlocking {
        val waiters = BesCrashReportWaiters()
        expectCode("glasses_not_connected") {
            waiters.await(keyA, "rep_1", 1_000) { throw BluetoothSdkException("glasses_not_connected", "no link") }
        }
        assertEquals(0, waiters.onAck(ack(keyA, "rep_1", ok = true)))
    }
}
