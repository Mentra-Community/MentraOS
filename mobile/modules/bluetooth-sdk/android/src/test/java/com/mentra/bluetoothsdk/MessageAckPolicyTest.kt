package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MessageAckPolicyTest {
    @Test
    fun `every non-ack message id is acknowledged regardless of type`() {
        assertEquals(17L, incomingGlassesMessageAckId("wifi_forget_result", 17L))
        assertEquals(18L, incomingGlassesMessageAckId("saved_wifi_networks", 18L))
        assertEquals(19L, incomingGlassesMessageAckId("future_terminal_type", 19L))
        assertNull(incomingGlassesMessageAckId("msg_ack", 20L))
        assertNull(incomingGlassesMessageAckId("wifi_forget_result", null))
    }
}
