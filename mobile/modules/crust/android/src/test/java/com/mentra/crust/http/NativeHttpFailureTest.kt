package com.mentra.crust.http

import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeHttpFailureTest {
    @Test fun `preserves failure category without exception text`() {
        val privateMessage = "https://private.example?token=secret SSID private-address"
        val cases = listOf(
            UnknownHostException(privateMessage) to "E_NATIVE_HTTP_DNS",
            ConnectException(privateMessage) to "E_NATIVE_HTTP_CONNECT",
            NoRouteToHostException(privateMessage) to "E_NATIVE_HTTP_CONNECT",
            SocketTimeoutException(privateMessage) to "E_NATIVE_HTTP_TIMEOUT",
            SSLHandshakeException(privateMessage) to "E_NATIVE_HTTP_TLS",
            SocketException(privateMessage) to "E_NATIVE_HTTP_SOCKET",
            InterruptedIOException(privateMessage) to "E_NATIVE_HTTP_INTERRUPTED",
            IOException(privateMessage) to "E_NATIVE_HTTP_IO",
            IllegalStateException(privateMessage) to "E_NATIVE_HTTP_OTHER",
        )
        cases.forEach { (error, expected) -> assertEquals(expected, nativeHttpFailureCode(error)) }
    }

    @Test fun `retains a specific cause inside a generic native wrapper`() {
        val wrapped = IOException("private wrapper", UnknownHostException("private hostname"))
        assertEquals("E_NATIVE_HTTP_DNS", nativeHttpFailureCode(wrapped))
        assertEquals("E_NATIVE_HTTP_IO", nativeHttpFailureCode(IllegalStateException(IOException("private"))))
    }

    @Test fun `never parses a category from private error text and bounds cyclic causes`() {
        assertEquals("E_NATIVE_HTTP_OTHER", nativeHttpFailureCode(Exception("E_NATIVE_HTTP_DNS")))
        val first = Exception("private one")
        val second = Exception("private two", first)
        first.initCause(second)
        assertEquals("E_NATIVE_HTTP_OTHER", nativeHttpFailureCode(first))
    }
}
