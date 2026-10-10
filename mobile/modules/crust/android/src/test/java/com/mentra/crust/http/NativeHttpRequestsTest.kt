package com.mentra.crust.http

import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Timeout
import org.junit.Assert.*
import org.junit.Test

class NativeHttpRequestsTest {
    private val request = Request.Builder().url("https://example.com/report").build()

    private class PendingCall(private val request: Request) : Call {
        var callback: Callback? = null
        var cancelled = false
        var onEnqueue: (() -> Unit)? = null
        override fun request() = request
        override fun execute(): Response = error("Test only exercises asynchronous calls")
        override fun enqueue(responseCallback: Callback) {
            callback = responseCallback
            onEnqueue?.invoke()
        }
        override fun cancel() {cancelled = true}
        override fun isExecuted() = callback != null
        override fun isCanceled() = cancelled
        override fun timeout() = Timeout.NONE
        override fun clone(): Call = PendingCall(request)
    }

    @Test fun `register before enqueue and cancel only the requested call`() {
        val calls = mutableListOf<PendingCall>()
        val owner = NativeHttpRequests(Call.Factory { req -> PendingCall(req).also {calls.add(it)} })
        owner.enqueue("one", request, {}, {throw it})
        calls[0].onEnqueue = {assertEquals(2, owner.activeCount)}
        owner.enqueue("two", request, {}, {throw it})
        assertEquals(2, owner.activeCount)
        owner.cancel("one")
        assertTrue(calls[0].cancelled)
        assertFalse(calls[1].cancelled)
        assertEquals(1, owner.activeCount)
        owner.cancel("not-owned")
        assertEquals(1, owner.activeCount)
        owner.cancelAll()
        assertTrue(calls[1].cancelled)
        assertEquals(0, owner.activeCount)
    }

    @Test fun `completion removes the active request and preserves the response`() {
        val call = PendingCall(request)
        val owner = NativeHttpRequests(Call.Factory {call})
        var result: NativeHttpRequests.Result? = null
        call.onEnqueue = {assertEquals(1, owner.activeCount)}
        owner.enqueue("complete", request, {result = it}, {throw it})
        call.callback!!.onResponse(call, Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
            .code(200).message("OK").header("Content-Type", "application/json").body("{}".toResponseBody()).build())
        assertEquals("{}", result!!.body)
        assertEquals("application/json", result!!.headers["content-type"])
        assertEquals(0, owner.activeCount)
        owner.cancel("complete")
        assertFalse(call.cancelled)
    }

    @Test fun `network failure and synchronous enqueue failure leave no registry entries`() {
        val call = PendingCall(request)
        val owner = NativeHttpRequests(Call.Factory {call})
        var failures = 0
        owner.enqueue("failed", request, {}, {failures++})
        call.callback!!.onFailure(call, IOException("offline"))
        assertEquals(0, owner.activeCount)
        call.onEnqueue = {throw IllegalStateException("dispatcher closed")}
        owner.enqueue("enqueue-failed", request, {}, {failures++})
        assertEquals(0, owner.activeCount)
        assertEquals(2, failures)
    }

    @Test fun `duplicate IDs cannot replace existing ownership and destruction prevents later requests`() {
        val calls = mutableListOf<PendingCall>()
        val owner = NativeHttpRequests(Call.Factory {req -> PendingCall(req).also {calls.add(it)} })
        var failures = 0
        owner.enqueue("one", request, {}, {failures++})
        owner.enqueue("one", request, {}, {failures++})
        assertEquals(1, failures)
        assertEquals(1, owner.activeCount)
        assertNull(calls[1].callback)
        owner.cancelAll()
        assertTrue(calls[0].cancelled)
        owner.enqueue("later", request, {}, {failures++})
        assertEquals(2, failures)
        assertEquals(2, calls.size)
        assertEquals(0, owner.activeCount)
    }

    @Test fun `cancel interrupts an actual OkHttp response body and closes the server socket`() {
        val client = OkHttpClient()
        val owner = NativeHttpRequests(client)
        val bodyStarted = CountDownLatch(1)
        val socketClosed = CountDownLatch(1)
        val failed = CountDownLatch(1)
        ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress()).use {server ->
            val thread = Thread {
                server.accept().use {socket ->
                    socket.soTimeout = 5_000
                    val reader = socket.getInputStream().bufferedReader()
                    while (!reader.readLine().isNullOrEmpty()) {}
                    socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n".toByteArray())
                    socket.getOutputStream().flush()
                    bodyStarted.countDown()
                    if (socket.getInputStream().read() == -1) socketClosed.countDown()
                }
            }
            thread.isDaemon = true
            thread.start()
            val req = Request.Builder().url("http://127.0.0.1:${server.localPort}/report").build()
            owner.enqueue("stalled-body", req, {fail("Cancelled body must not complete")}, {failed.countDown()})
            assertTrue("server started body", bodyStarted.await(5, TimeUnit.SECONDS))
            owner.cancel("stalled-body")
            assertTrue("native request rejected", failed.await(5, TimeUnit.SECONDS))
            assertTrue("socket closed", socketClosed.await(5, TimeUnit.SECONDS))
            assertEquals(0, owner.activeCount)
            thread.join(5_000)
        }
        client.dispatcher.executorService.shutdownNow()
        client.connectionPool.evictAll()
    }
}
