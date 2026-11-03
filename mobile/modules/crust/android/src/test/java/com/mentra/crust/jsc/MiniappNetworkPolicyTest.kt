package com.mentra.crust.jsc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiniappNetworkPolicyTest {
    @Test fun `fetch reaches only http and https`() {
        for (url in listOf("http://example.com", "https://example.com/a?b", "HTTPS://EXAMPLE.COM", " https://example.com")) {
            assertTrue(url, MiniappNetworkPolicy.allowsFetch(url))
        }
        for (url in listOf(
            "file:///data/data/com.mentra.mentra/files/mmkv/mmkv.default",
            "FILE:///etc/hosts",
            "\tfile:///etc/hosts",
            "content://com.mentra.mentra.fileprovider/cache/x",
            "data:text/plain,hi",
            "jar:file:///x!/y",
            "ws://example.com",
            "/data/data/com.mentra.mentra/files",
            "relative/path",
            "",
        )) {
            assertFalse(url, MiniappNetworkPolicy.allowsFetch(url))
        }
    }

    @Test fun `WebSockets reach only ws, wss, http and https`() {
        for (url in listOf("ws://10.0.0.2:9000", "WSS://example.com/s", "http://example.com", "https://example.com")) {
            assertTrue(url, MiniappNetworkPolicy.allowsWebSocket(url))
        }
        for (url in listOf("file:///etc/hosts", "content://x/y", "data:,x", "/socket")) {
            assertFalse(url, MiniappNetworkPolicy.allowsWebSocket(url))
        }
    }

    @Test fun `scheme is lowercased and absent for a relative URL`() {
        assertEquals("file", MiniappNetworkPolicy.scheme("FiLe:///x"))
        assertEquals("https", MiniappNetworkPolicy.scheme("\u0000 https://x"))
        assertNull(MiniappNetworkPolicy.scheme("/x"))
        assertNull(MiniappNetworkPolicy.scheme("1http://x"))
    }
}
