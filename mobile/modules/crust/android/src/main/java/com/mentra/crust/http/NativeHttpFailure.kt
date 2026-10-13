package com.mentra.crust.http

import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** Fixed diagnostic codes only: exception messages can contain private URLs and addresses. */
internal fun nativeHttpFailureCode(error: Throwable): String {
    var current: Throwable? = error
    var fallback = "E_NATIVE_HTTP_OTHER"
    // Native wrappers can retain the useful cause. Bound traversal even for a cyclic cause chain.
    repeat(8) {
        val cause = current ?: return fallback
        when (cause) {
            is UnknownHostException -> return "E_NATIVE_HTTP_DNS"
            is SocketTimeoutException -> return "E_NATIVE_HTTP_TIMEOUT"
            is SSLException -> return "E_NATIVE_HTTP_TLS"
            is ConnectException, is NoRouteToHostException -> return "E_NATIVE_HTTP_CONNECT"
            is SocketException -> return "E_NATIVE_HTTP_SOCKET"
            is InterruptedIOException -> return "E_NATIVE_HTTP_INTERRUPTED"
            is IOException -> fallback = "E_NATIVE_HTTP_IO"
        }
        current = cause.cause
    }
    return fallback
}
