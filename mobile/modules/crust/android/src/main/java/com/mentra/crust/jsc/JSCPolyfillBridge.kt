package com.mentra.crust.jsc

import android.util.Log
import java.io.IOException
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Call
import okhttp3.Callback
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import org.json.JSONArray
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import android.util.Base64

/**
 * Native bridge for the network polyfills that can't be implemented in
 * pure JS (fetch, WebSocket). Mirrors iOS [JSCPolyfillBridge.swift].
 *
 * Each request opens an OkHttp call that outlives the originating
 * __dispatch invocation, so we route the response back via
 * [JSCRuntime.dispatchToJs] when the call completes. The JS polyfill's
 * Promise correlator (the `__mentraSendRequest` reqId map) takes it from
 * there.
 *
 * Microtask discipline: the response evaluator goes through the
 * QuickJs.evaluate path (bridge re-entry) which drains pending Promise
 * jobs automatically. We never need to call QuickJS's private
 * `JS_ExecutePendingJob` — see the spec's Android microtask section.
 */
object JSCPolyfillBridge {
    private const val TAG = "MentraJS.PolyfillBridge"

    private val httpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .callTimeout(120, TimeUnit.SECONDS)
            .build()
    }

    data class HttpResult(
        val status: Int,
        val statusText: String,
        val headers: Map<String, String>,
        val body: String,
    )

    /** Shared OkHttp execution path for host cloud-client requests. */
    fun executeHttp(method: String, url: String, headers: Map<String, String>, bodyString: String?): HttpResult {
        val builder = Request.Builder().url(url)
        for ((name, value) in headers) builder.header(name, value)
        val contentType = headers.entries
            .firstOrNull { (name, _) -> name.equals("content-type", ignoreCase = true) }
            ?.value
        val upperMethod = method.uppercase()
        val requestBody = when {
            bodyString != null -> bodyString.toRequestBody((contentType ?: "application/octet-stream").toMediaTypeOrNull())
            upperMethod == "POST" || upperMethod == "PUT" || upperMethod == "PATCH" -> "".toRequestBody(null)
            else -> null
        }
        builder.method(upperMethod, requestBody)
        httpClient.newCall(builder.build()).execute().use { response ->
            val responseHeaders = mutableMapOf<String, String>()
            for (name in response.headers.names()) {
                responseHeaders[name.lowercase()] = response.headers.values(name).joinToString(", ")
            }
            return HttpResult(
                status = response.code,
                statusText = response.message,
                headers = responseHeaders,
                body = response.body?.string() ?: "",
            )
        }
    }

    /** Idempotent. Call once on host boot, after the dispatcher is created. */
    fun install(runtime: JSCRuntime) {
        installFetch(runtime)
        installWebSocket(runtime)
    }

    private val sockets = ConcurrentHashMap<String, OkSocketRecord>()

    private data class OkSocketRecord(
        val packageName: String,
        val socket: WebSocket,
        @Volatile var closedSent: Boolean = false,
    )

    private fun installWebSocket(runtime: JSCRuntime) {
        runtime.dispatcher.register("ws", "open") { packageName, args, _ ->
            val req = args.firstOrNull() as? Map<*, *>
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.open expects {sid, url, protocols?}")
            val sid = req["sid"] as? String
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.open: missing sid")
            val url = req["url"] as? String
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.open: missing url")
            val protocols = (req["protocols"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
            val builder = Request.Builder().url(url)
            if (protocols.isNotEmpty()) {
                builder.header("Sec-WebSocket-Protocol", protocols.joinToString(", "))
            }
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                    val proto = response.header("Sec-WebSocket-Protocol")
                    val payload = if (proto.isNullOrEmpty()) emptyMap<String, Any?>() else mapOf("protocol" to proto)
                    deliverEvent(runtime, packageName, sid, "open", payload)
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    deliverEvent(runtime, packageName, sid, "message", mapOf("kind" to "text", "data" to text))
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    val b64 = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
                    deliverEvent(runtime, packageName, sid, "message", mapOf("kind" to "binary", "data" to b64))
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    val rec = sockets.remove(sid) ?: return
                    if (!rec.closedSent) {
                        rec.closedSent = true
                        deliverEvent(runtime, packageName, sid, "close", mapOf("code" to code, "reason" to reason))
                    }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                    deliverEvent(runtime, packageName, sid, "error", mapOf("message" to (t.message ?: "ws error")))
                    val rec = sockets.remove(sid) ?: return
                    if (!rec.closedSent) {
                        rec.closedSent = true
                        deliverEvent(runtime, packageName, sid, "close", mapOf("code" to 1006, "reason" to (t.message ?: "")))
                    }
                }
            }
            val socket = httpClient.newWebSocket(builder.build(), listener)
            sockets[sid] = OkSocketRecord(packageName, socket)
            JSCDispatchOutcome.Sync("null")
        }

        runtime.dispatcher.register("ws", "send") { _, args, _ ->
            val req = args.firstOrNull() as? Map<*, *>
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.send expects {sid, kind, payload}")
            val sid = req["sid"] as? String
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.send: missing sid")
            val kind = req["kind"] as? String
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.send: missing kind")
            val payload = req["payload"] as? String
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.send: missing payload")
            val rec = sockets[sid]
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.send: unknown sid")
            val ok = when (kind) {
                "text" -> rec.socket.send(payload)
                "binary" -> {
                    val bytes = try {
                        Base64.decode(payload, Base64.DEFAULT)
                    } catch (e: IllegalArgumentException) {
                        return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.send: bad base64")
                    }
                    rec.socket.send(bytes.toByteString())
                }
                else -> return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.send: kind must be text|binary")
            }
            if (!ok) {
                Log.w(TAG, "ws.send returned false for sid=$sid (queue full?)")
            }
            JSCDispatchOutcome.Sync("null")
        }

        runtime.dispatcher.register("ws", "close") { _, args, _ ->
            val req = args.firstOrNull() as? Map<*, *>
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.close expects {sid, code?, reason?}")
            val sid = req["sid"] as? String
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "ws.close: missing sid")
            val rec = sockets[sid] ?: return@register JSCDispatchOutcome.Sync("null")
            val code = (req["code"] as? Number)?.toInt() ?: 1000
            val reason = (req["reason"] as? String) ?: ""
            rec.socket.close(code, reason)
            JSCDispatchOutcome.Sync("null")
        }
    }

    private fun deliverEvent(
        runtime: JSCRuntime,
        packageName: String,
        sid: String,
        wsType: String,
        payload: Map<String, Any?>,
    ) {
        val envelope = JSONObject().apply {
            put("kind", "ws-event")
            put("sid", sid)
            put("wsType", wsType)
            put("payload", JSONObject(payload as Map<*, *>))
        }
        runtime.dispatchToJs(packageName, envelope.toString())
    }

    private fun installFetch(runtime: JSCRuntime) {
        runtime.dispatcher.register("fetch", "request") { packageName, args, reqId ->
            val req = args.firstOrNull() as? Map<*, *>
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "fetch.request expects {url,...}")
            val url = req["url"] as? String
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "fetch.request: missing url")
            if (reqId == null) {
                return@register JSCDispatchOutcome.Error("INVALID_ARGS", "fetch.request requires reqId (use __mentraSendRequest)")
            }

            val method = (req["method"] as? String) ?: "GET"
            val headers = (req["headers"] as? Map<*, *>)?.mapNotNull { (k, v) ->
                val ks = k as? String ?: return@mapNotNull null
                val vs = (v as? String) ?: v?.toString() ?: return@mapNotNull null
                ks to vs
            }?.toMap() ?: emptyMap()
            val bodyString = req["body"] as? String

            val builder = Request.Builder().url(url)
            for ((k, v) in headers) builder.header(k, v)
            // HTTP header names are case-insensitive. The JS fetch caller will
            // commonly provide `Content-Type`; a direct lowercase map lookup
            // misses that value and causes OkHttp to emit application/octet-stream.
            val contentType = headers.entries
                .firstOrNull { (name, _) -> name.equals("content-type", ignoreCase = true) }
                ?.value
            val body = if (bodyString.isNullOrEmpty()) null else bodyString.toRequestBody(
                (contentType ?: "application/octet-stream").toMediaTypeOrNull()
            )
            builder.method(method.uppercase(), body)

            httpClient.newCall(builder.build()).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    deliverError(runtime, packageName, reqId, "fetch: ${e.message}")
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use { r ->
                        val status = r.code
                        val statusText = r.message
                        val headerMap = mutableMapOf<String, String>()
                        for (name in r.headers.names()) {
                            headerMap[name.lowercase()] = r.headers.values(name).joinToString(", ")
                        }
                        val bodyStr = try {
                            r.body?.string() ?: ""
                        } catch (e: Throwable) {
                            Log.w(TAG, "fetch read body threw: ${e.message}")
                            ""
                        }
                        val envelope = JSONObject().apply {
                            put("kind", "response")
                            put("reqId", reqId)
                            put("ok", true)
                            put("result", JSONObject().apply {
                                put("status", status)
                                put("statusText", statusText)
                                put("headers", JSONObject(headerMap as Map<*, *>))
                                put("body", bodyStr)
                                put("ok", status in 200..299)
                            })
                        }
                        runtime.dispatchToJs(packageName, envelope.toString())
                    }
                }
            })
            JSCDispatchOutcome.Async
        }
    }

    private fun deliverError(runtime: JSCRuntime, packageName: String, reqId: String, message: String) {
        val envelope = JSONObject().apply {
            put("kind", "response")
            put("reqId", reqId)
            put("ok", false)
            put("error", JSONObject().apply {
                put("code", "NATIVE_THROW")
                put("message", message)
            })
        }
        runtime.dispatchToJs(packageName, envelope.toString())
    }
}
