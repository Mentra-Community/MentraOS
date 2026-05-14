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
import org.json.JSONObject
import java.util.concurrent.TimeUnit

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

    /** Idempotent. Call once on host boot, after the dispatcher is created. */
    fun install(runtime: JSCRuntime) {
        installFetch(runtime)
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
            val body = if (bodyString.isNullOrEmpty()) null else bodyString.toRequestBody(
                (headers["content-type"] ?: "application/octet-stream").toMediaTypeOrNull()
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
