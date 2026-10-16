package com.mentra.bluetoothsdk

import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.sgcs.G1PairingTest
import com.mentra.bluetoothsdk.sgcs.MentraLive
import java.util.concurrent.ConcurrentLinkedQueue
import com.mentra.bluetoothsdk.utils.K900ProtocolUtils
import com.mentra.bluetoothsdk.utils.K900LengthCodec
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class, TouchGestureCommandTest.ShadowK900Encoder::class], instrumentedPackages = ["com.mentra.lc3Lib"])
class TouchGestureCommandTest {
    @Implements(K900ProtocolUtils::class)
    class ShadowK900Encoder {
        companion object {
            var beforeEncode: (() -> Unit)? = null
            @JvmStatic
            @Implementation
            fun packDataToK900(data: ByteArray, cmdType: Byte, endian: K900LengthCodec.Endian): ByteArray? {
                beforeEncode?.invoke()
                return Shadow.directlyOn(K900ProtocolUtils::class.java, "packDataToK900",
                    ClassParameter.from(ByteArray::class.java, data),
                    ClassParameter.from(Byte::class.javaPrimitiveType!!, cmdType),
                    ClassParameter.from(K900LengthCodec.Endian::class.java, endian))
            }
        }
    }

    @Test
    fun `disconnect during encoding cannot promote touch setting into next session`() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val live = MentraLive()
        val connection = MentraLive::class.java.getDeclaredField("isConnected").apply { isAccessible = true }
        connection.setBoolean(live, true)
        val queue = MentraLive::class.java.getDeclaredField("sendQueue").apply { isAccessible = true }
            .get(live) as ConcurrentLinkedQueue<*>
        val generation = MentraLive::class.java.getDeclaredField("bleSessionGeneration").apply { isAccessible = true }
            .get(live) as AtomicLong
        val admittedGeneration = generation.get()
        val reset = MentraLive::class.java.getDeclaredMethod("resetPendingAckState").apply { isAccessible = true }
        ShadowK900Encoder.beforeEncode = {
            connection.setBoolean(live, false)
            reset.invoke(live)
            queue.clear()
            connection.setBoolean(live, true)
        }
        try {
            live.sendTouchGestureDefaultBehaviorEnabled("old-session", TouchGesture.DOUBLE_TAP, false)
            val queued = queue.poll()!!
            val queuedGeneration = queued.javaClass.getDeclaredField("sessionGeneration").apply { isAccessible = true }.getLong(queued)
            assertEquals(admittedGeneration, queuedGeneration)
            assertNotEquals(generation.get(), queuedGeneration)
        } finally { ShadowK900Encoder.beforeEncode = null }
    }

    @Test
    fun `each gesture serializes independently and acknowledgements retain typed event values`() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val live = MentraLive()
        val connection = MentraLive::class.java.getDeclaredField("isConnected").apply { isAccessible = true }
        connection.setBoolean(live, true)
        val queue = MentraLive::class.java.getDeclaredField("sendQueue").apply { isAccessible = true }
            .get(live) as ConcurrentLinkedQueue<*>
        val receive = MentraLive::class.java.getDeclaredMethod("processK900JsonMessage", JSONObject::class.java)
            .apply { isAccessible = true }
        val events = mutableListOf<Map<String, Any>>()
        val sink = Bridge.addEventSink { name, values -> if (name == "settings_ack") events.add(values) }
        try {
            for (gesture in TouchGesture.entries) for (enabled in listOf(false, true)) {
                live.sendTouchGestureDefaultBehaviorEnabled("request-${gesture.wireName}-$enabled", gesture, enabled)
                val queued = queue.poll()!!
                val bytes = queued.javaClass.getDeclaredField("data").apply { isAccessible = true }.get(queued) as ByteArray
                assertEquals('#'.code.toByte(), bytes[0])
                assertEquals('$'.code.toByte(), bytes.last())
                val envelope = JSONObject(String(bytes, 5, bytes.size - 7, Charsets.UTF_8))
                assertEquals("cs_tpdef", envelope.getString("C"))
                val body = JSONObject(envelope.getString("B"))
                assertEquals(gesture.wireName, body.getString("gesture"))
                assertEquals(enabled, body.getBoolean("enabled"))
                val ack = JSONObject().put("type", "settings_ack").put("setting", "touch_gesture_default")
                    .put("status", "applied").put("request_id", body.getString("request_id"))
                    .put("gesture", gesture.wireName).put("enabled", enabled)
                receive.invoke(live, JSONObject().put("C", "sr_tpdef").put("B", if (enabled) ack.toString() else ack))
                assertEquals(body.getString("request_id"), events.last()["requestId"])
                assertEquals(enabled, events.last()["enabled"])
                assertEquals(gesture.wireName, events.last()["gesture"])
            }
            assertEquals(16, events.size)
        } finally { Bridge.removeEventSink(sink) }
    }

    @Test
    fun `invalid gesture and disconnected radio reject before sending`() {
        assertThrows(BluetoothSdkException::class.java) { TouchGesture.fromWireName("unknown") }
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val live = MentraLive()
        assertThrows(BluetoothSdkException::class.java) {
            live.sendTouchGestureDefaultBehaviorEnabled("request", TouchGesture.DOUBLE_TAP, false)
        }
    }
}
