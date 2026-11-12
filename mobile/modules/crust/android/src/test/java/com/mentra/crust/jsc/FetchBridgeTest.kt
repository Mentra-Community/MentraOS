package com.mentra.crust.jsc

import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import okio.ByteString.Companion.decodeBase64
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Miniapp `fetch` end to end on Android's real stack: the shipped startup.js
 * polyfill in QuickJS, [JSCRuntime]'s dispatcher and `__deliver` path, this
 * bridge, and OkHttp against a local server. Each miniapp script reports
 * through a `test` dispatch, which the runtime forwards to `onOutbound`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class FetchBridgeTest {
    private val packageName = "com.mentra.fetchtest"
    private val results = LinkedBlockingQueue<Map<*, *>>()
    private lateinit var server: MockWebServer
    private lateinit var runtime: JSCRuntime
    @Volatile private var redirectTarget = "file:///etc/hosts"

    /** A 24 kHz 16-bit sine followed by every byte value: mostly not valid UTF-8. */
    private val pcm = ByteArray(4800 * 2 + 256).also { out ->
        for (i in 0 until 4800) {
            val sample = (sin(2 * PI * 220 * i / 24000) * 20000).roundToInt()
            out[2 * i] = sample.toByte()
            out[2 * i + 1] = (sample shr 8).toByte()
        }
        for (value in 0 until 256) out[9600 + value] = value.toByte()
    }

    /** Valid UTF-8 that is still binary data: a BOM, NUL and DEL must all survive. */
    private val utf8Bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) +
        "{\"a\":\"é😀\"}".toByteArray(Charsets.UTF_8) + byteArrayOf(0x00, 0x7F)

    /** Two MB of valid UTF-8 text: arrayBuffer() re-encodes it inside the 32 MB miniapp heap. */
    private val largeUtf8Text: ByteArray =
        "héllo 😀 中文 chunk of reply text ".repeat(52_000).toByteArray(Charsets.UTF_8)

    // crust's build.gradle ships this file as the runtime's startup.js asset.
    private val polyfill: String by lazy { File("../../jspolyfill/assets/startup.js").readText() }

    @Before fun setUp() {
        server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                    "/reply.pcm" -> response("application/octet-stream").setBody(Buffer().write(pcm))
                    "/utf8.bin" -> response("application/octet-stream").setBody(Buffer().write(utf8Bytes))
                    "/large.txt" -> response("text/plain").setBody(Buffer().write(largeUtf8Text))
                    "/data.json" -> response("application/json").setBody("{\"message\":\"héllo 😀 中文\"}")
                    "/upload" -> response("text/plain").setBody("ok")
                    "/to-file" -> MockResponse().setResponseCode(302).setHeader("Location", redirectTarget)
                    else -> MockResponse().setResponseCode(404)
                }
            }
            start()
        }
        runtime = JSCRuntime.shared(RuntimeEnvironment.getApplication())
        JSCPolyfillBridge.install(runtime)
        runtime.onOutbound = { message ->
            if (message.payload["iface"] == "test") {
                results.add((message.payload["args"] as List<*>).first() as Map<*, *>)
            }
        }
    }

    @After fun tearDown() {
        runtime.kill(packageName)
        runtime.onOutbound = null
        server.shutdown()
    }

    @Test fun `arrayBuffer returns the exact bytes of a binary response`() {
        val result = runMiniapp(
            """
            const response = await fetch(BASE + "/reply.pcm")
            const bytes = new Uint8Array(await response.arrayBuffer())
            return {status: response.status, type: response.headers.get("content-type"), bytes: Array.from(bytes)}
            """,
        )
        assertEquals(200, result["status"])
        assertEquals("application/octet-stream", result["type"])
        assertArrayEquals(pcm, bytes(result["bytes"]))
    }

    @Test fun `arrayBuffer returns the exact bytes of a body that is valid UTF-8`() {
        val result = runMiniapp(
            """
            const response = await fetch(BASE + "/utf8.bin")
            return {bytes: Array.from(new Uint8Array(await response.arrayBuffer()))}
            """,
        )
        assertArrayEquals(utf8Bytes, bytes(result["bytes"]))
    }

    @Test fun `arrayBuffer re-encodes a large UTF-8 body within the miniapp heap`() {
        val result = runMiniapp(
            """
            const bytes = new Uint8Array(await (await fetch(BASE + "/large.txt")).arrayBuffer())
            let sum = 0
            for (let i = 0; i < bytes.length; i++) sum = (sum * 31 + bytes[i]) >>> 0
            return {length: bytes.length, sum}
            """,
        )
        var sum = 0L
        for (byte in largeUtf8Text) sum = (sum * 31 + (byte.toInt() and 0xFF)) and 0xFFFFFFFFL
        assertEquals(largeUtf8Text.size, (result["length"] as Number).toInt())
        assertEquals(sum, (result["sum"] as Number).toLong())
    }

    @Test fun `responses are sent as text only when that text re-encodes to the same bytes`() {
        val text = JSCPolyfillBridge.fetchResult(responseWith(utf8Bytes))
        assertEquals(String(utf8Bytes, Charsets.UTF_8), text.getString("body"))
        assertFalse(text.has("bodyBase64"))

        val empty = JSCPolyfillBridge.fetchResult(responseWith(ByteArray(0)))
        assertEquals("", empty.getString("body"))

        // Truncated, overlong, surrogate and out-of-range sequences, then raw PCM.
        for (binary in listOf(byteArrayOf(0x41, 0xE2.toByte(), 0x82.toByte()), byteArrayOf(0xC0.toByte(), 0x80.toByte()),
            byteArrayOf(0xED.toByte(), 0xA0.toByte(), 0x80.toByte()), byteArrayOf(0xF4.toByte(), 0x90.toByte(), 0x80.toByte(), 0x80.toByte()), pcm)) {
            val result = JSCPolyfillBridge.fetchResult(responseWith(binary))
            assertFalse(result.has("body"))
            assertArrayEquals(binary, result.getString("bodyBase64").decodeBase64()!!.toByteArray())
        }
    }

    @Test fun `text and json decode a UTF-8 response`() {
        val result = runMiniapp(
            """
            const text = await (await fetch(BASE + "/data.json")).text()
            const json = await (await fetch(BASE + "/data.json")).json()
            return {text, message: json.message}
            """,
        )
        assertEquals("{\"message\":\"héllo 😀 中文\"}", result["text"])
        assertEquals("héllo 😀 中文", result["message"])
    }

    @Test fun `binary request bodies reach the server byte for byte`() {
        val result = runMiniapp(
            """
            const backing = Uint8Array.from({length: 600}, (_, i) => (i * 37 + 11) & 255)
            const response = await fetch(BASE + "/upload", {
              method: "POST",
              headers: {"Content-Type": "audio/L16; rate=24000"},
              body: backing.subarray(44),
            })
            return {status: response.status, text: await response.text()}
            """,
        )
        assertEquals(200, result["status"])
        assertEquals("ok", result["text"])
        val upload = server.takeRequest()
        val expected = ByteArray(600) { ((it * 37 + 11) and 255).toByte() }.copyOfRange(44, 600)
        assertArrayEquals(expected, upload.body.readByteArray())
        assertEquals("audio/L16; rate=24000", upload.getHeader("Content-Type"))
    }

    @Test fun `string request bodies keep their UTF-8 text and content type`() {
        runMiniapp(
            """
            await fetch(BASE + "/upload", {method: "POST", headers: {"Content-Type": "application/json"}, body: '{"t":"é😀"}'})
            return {}
            """,
        )
        val upload = server.takeRequest()
        assertEquals("{\"t\":\"é😀\"}", upload.body.readUtf8())
        assertEquals("application/json; charset=utf-8", upload.getHeader("Content-Type"))
    }

    /**
     * Miniapp code is untrusted and can call the bridge without the polyfill's own check, so
     * native must refuse a local URL itself. A file: URL would read the Mentra App's files.
     */
    @Test fun `native fetch and WebSocket refuse local URLs even when the polyfill is skipped`() {
        val secret = File.createTempFile("mentra-credentials", ".txt").apply {
            writeText("refresh-token-that-must-not-leak")
            deleteOnExit()
        }
        val urls = listOf(secret.toURI().toString(), "FILE://${secret.absolutePath}", "content://com.mentra.mentra.fileprovider/x", "data:text/plain,hi")
        val result = runMiniapp(
            """
            const outcomes = []
            for (const url of ${org.json.JSONArray(urls)}) {
              outcomes.push(await __mentraSendRequest("fetch", "request", [{url, method: "GET", headers: {}}]).then(
                (r) => ({read: String(r && (r.body || r.bodyBase64))}),
                (e) => ({error: String(e && (e.message || e.code))}),
              ))
              let opened = false
              try {
                __dispatch("ws", "open", JSON.stringify([{sid: "s-" + outcomes.length, url, protocols: []}]))
                opened = true
              } catch (e) {
                outcomes.push({error: String(e && e.message)})
              }
              if (opened) outcomes.push({read: "ws opened"})
            }
            return {outcomes}
            """,
        )
        val outcomes = result["outcomes"] as List<*>
        assertEquals(urls.size * 2, outcomes.size)
        for (outcome in outcomes) {
            val map = outcome as Map<*, *>
            assertNull("a local URL was read: $map", map["read"])
            assertTrue("unexpected refusal: $map", (map["error"] as String).contains("URLs are allowed"))
        }
    }

    /** OkHttp follows a redirect only to another http(s) URL, so a 302 to a file: URL reads nothing. */
    @Test fun `a redirect to a file URL is not followed`() {
        val secret = File.createTempFile("mentra-credentials", ".txt").apply {
            writeText("refresh-token-that-must-not-leak")
            deleteOnExit()
        }
        redirectTarget = secret.toURI().toString()
        val result = runMiniapp(
            """
            const response = await fetch(BASE + "/to-file")
            return {status: response.status, text: await response.text()}
            """,
        )
        assertEquals(302, result["status"])
        assertFalse((result["text"] as String).contains("refresh-token"))
    }

    private fun runMiniapp(body: String): Map<*, *> {
        val script =
            """
            const BASE = "${server.url("/").toString().removeSuffix("/")}"
            const report = (value) => __mentraSendOneShot("test", "result", [value])
            ;(async () => {
              $body
            })().then(report, (error) => report({error: String(error && (error.message || error))}))
            """.trimIndent()
        assertTrue("spawn failed", runtime.spawn(packageName, polyfill, script))
        val result = results.poll(15, TimeUnit.SECONDS) ?: throw AssertionError("miniapp did not report a result")
        assertNull("miniapp script threw", result["error"])
        return result
    }

    private fun bytes(value: Any?): ByteArray =
        (value as List<*>).map { (it as Number).toInt().toByte() }.toByteArray()

    private fun response(contentType: String) = MockResponse().setHeader("Content-Type", contentType)

    private fun responseWith(body: ByteArray): Response = Response.Builder()
        .request(Request.Builder().url("https://example.com/body").build())
        .protocol(Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .body(body.toResponseBody("application/octet-stream".toMediaType()))
        .build()
}
