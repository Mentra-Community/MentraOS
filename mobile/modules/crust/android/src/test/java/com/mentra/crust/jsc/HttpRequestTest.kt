package com.mentra.crust.jsc

import okhttp3.Request
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class HttpRequestTest {
    private fun request(method: String, body: String? = null): Request =
        JSCPolyfillBridge.buildHttpRequest(method, "https://example.com/stream", mapOf("Content-Type" to "application/json"), body)

    @Test fun `bodyless post put and patch produce valid zero byte requests`() {
        for (method in listOf("post", "PUT", "PATCH")) for (body in listOf(null, "")) {
            val request = request(method, body)
            assertEquals(method.uppercase(), request.method)
            assertNotNull(request.body)
            assertEquals(0L, request.body!!.contentLength())
        }
    }

    @Test fun `get head and delete can omit a body`() {
        for (method in listOf("GET", "HEAD", "DELETE")) assertNull(request(method).body)
    }

    @Test fun `nonempty body and content type survive request construction`() {
        val request = request("POST", "{\"status\":\"stopped\"}")
        val buffer = Buffer()
        request.body!!.writeTo(buffer)
        assertEquals("{\"status\":\"stopped\"}", buffer.readUtf8())
        assertEquals("application/json; charset=utf-8", request.body!!.contentType().toString())
    }
}
