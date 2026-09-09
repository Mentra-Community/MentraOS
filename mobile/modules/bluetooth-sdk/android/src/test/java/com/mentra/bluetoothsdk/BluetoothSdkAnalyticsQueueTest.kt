package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BluetoothSdkAnalyticsQueueTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun payload(id: String) = JSONObject().put("uuid", id).put("event", "bluetooth_sdk_started")

    @Test
    fun `drains oldest first and keeps what still fails, preserving order`() {
        val queue = BluetoothSdkAnalyticsQueue(folder.newFile("queue.jsonl"))
        queue.enqueue(payload("a"), nowMillis = 1_000)
        queue.enqueue(payload("b"), nowMillis = 2_000)
        queue.enqueue(payload("c"), nowMillis = 3_000)

        val sent = mutableListOf<String>()
        queue.drain(nowMillis = 4_000) { p ->
            val id = p.getString("uuid")
            if (id == "b") false else sent.add(id)
        }
        assertThat(sent).containsExactly("a")
        assertThat(queue.size()).isEqualTo(2)

        val second = mutableListOf<String>()
        queue.drain(nowMillis = 5_000) { second.add(it.getString("uuid")) }
        assertThat(second).containsExactly("b", "c")
        assertThat(queue.size()).isZero()
    }

    @Test
    fun `drops the oldest entries past the cap and expired entries on drain`() {
        val queue = BluetoothSdkAnalyticsQueue(folder.newFile("queue.jsonl"), maxEntries = 2, maxAgeMillis = 10_000)
        queue.enqueue(payload("old"), nowMillis = 0)
        queue.enqueue(payload("mid"), nowMillis = 5_000)
        queue.enqueue(payload("new"), nowMillis = 6_000)
        assertThat(queue.size()).isEqualTo(2)

        val sent = mutableListOf<String>()
        queue.drain(nowMillis = 16_000) { sent.add(it.getString("uuid")) }
        assertThat(sent).containsExactly("new")
    }

    @Test
    fun `survives a corrupt line and a throwing sender`() {
        val file = folder.newFile("queue.jsonl")
        val queue = BluetoothSdkAnalyticsQueue(file)
        queue.enqueue(payload("a"), nowMillis = 1_000)
        file.appendText("not json\n")
        queue.enqueue(payload("b"), nowMillis = 2_000)
        assertThat(queue.size()).isEqualTo(2)

        queue.drain(nowMillis = 3_000) { throw IllegalStateException("network") }
        assertThat(queue.size()).isEqualTo(2)
    }
}
