package com.mentra.bluetoothsdk.hotspot

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiDirectStartAnswerTest {
    @Test
    fun `the stopped of the group a release removed doesn't answer the next start`() {
        val answer = WifiDirectJoin.StartAnswer()
        assertFalse(answer.answers("stopped", hasError = false))
        assertFalse(answer.answers("starting", hasError = false))
        assertTrue(answer.answers("ready", hasError = false))
    }

    @Test
    fun `a stopped after starting ends the start`() {
        val answer = WifiDirectJoin.StartAnswer()
        assertFalse(answer.answers("starting", hasError = false))
        assertTrue(answer.answers("stopped", hasError = false))
    }

    @Test
    fun `the glasses disconnecting ends the start at once`() {
        assertTrue(WifiDirectJoin.StartAnswer().answers("stopped", hasError = true))
    }

    @Test
    fun `a group already up or an error answers at once`() {
        assertTrue(WifiDirectJoin.StartAnswer().answers("ready", hasError = false))
        assertTrue(WifiDirectJoin.StartAnswer().answers("error", hasError = true))
    }
}
