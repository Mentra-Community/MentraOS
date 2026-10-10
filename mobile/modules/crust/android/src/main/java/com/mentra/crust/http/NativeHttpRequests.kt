package com.mentra.crust.http

import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response

/** Calls owned by one Expo module, separate from miniapp fetch and WebSocket traffic. */
internal class NativeHttpRequests(private val client: Call.Factory) {
    data class Result(
        val status: Int,
        val statusText: String,
        val headers: Map<String, String>,
        val body: String,
    )

    private val calls = ConcurrentHashMap<String, Call>()
    private val closed = AtomicBoolean(false)
    internal val activeCount: Int get() = calls.size

    fun enqueue(
        requestId: String,
        request: Request,
        onResult: (Result) -> Unit,
        onError: (Throwable) -> Unit,
    ) {
        if (closed.get()) {
            onError(IllegalStateException("Native HTTP module is closed"))
            return
        }
        val call = client.newCall(request)
        if (calls.putIfAbsent(requestId, call) != null) {
            onError(IllegalArgumentException("Native HTTP request ID is already active"))
            return
        }
        // Destruction may run on a different thread from Expo's serial request queue.
        if (closed.get()) {
            calls.remove(requestId, call)
            call.cancel()
            onError(IllegalStateException("Native HTTP module is closed"))
            return
        }
        try {
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    calls.remove(requestId, call)
                    onError(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = try {
                        response.use { r ->
                            val headers = r.headers.names().associate { name ->
                                name.lowercase() to r.headers.values(name).joinToString(", ")
                            }
                            Result(r.code, r.message, headers, r.body?.string() ?: "")
                        }
                    } catch (e: Throwable) {
                        calls.remove(requestId, call)
                        onError(e)
                        return
                    }
                    calls.remove(requestId, call)
                    onResult(result)
                }
            })
        } catch (e: Throwable) {
            calls.remove(requestId, call)
            onError(e)
        }
    }

    fun cancel(requestId: String) {
        calls.remove(requestId)?.cancel()
    }

    fun cancelAll() {
        closed.set(true)
        for ((requestId, call) in calls) {
            if (calls.remove(requestId, call)) call.cancel()
        }
    }
}
