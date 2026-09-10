package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class BluetoothSdkAnalyticsTransportTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun payload(id: String) = JSONObject().put("uuid", id)

    @Test
    fun `a drain started by an old instance cannot overwrite an event a new instance persists`() {
        val queue = BluetoothSdkAnalyticsQueue(folder.newFile("queue.jsonl"))
        queue.enqueue(payload("old"), nowMillis = 1_000)
        val drainStarted = CountDownLatch(1)
        val newInstanceReady = CountDownLatch(1)

        // "Old instance": a slow drain that snapshots the file, then rewrites it.
        BluetoothSdkAnalyticsTransport.submit {
            queue.drain(nowMillis = 2_000) {
                drainStarted.countDown()
                newInstanceReady.await(2, TimeUnit.SECONDS)
                SendOutcome.DELIVERED
            }
        }
        // "New instance": persists a failed event while that drain is in progress.
        // Through the shared executor it is serialized after the drain instead of
        // racing its rewrite.
        assertThat(drainStarted.await(2, TimeUnit.SECONDS)).isTrue()
        BluetoothSdkAnalyticsTransport.submit { queue.enqueue(payload("new"), nowMillis = 3_000) }
        newInstanceReady.countDown()
        BluetoothSdkAnalyticsTransport.awaitIdle()

        val remaining = mutableListOf<String>()
        queue.drain(nowMillis = 4_000) { p -> SendOutcome.RETRY.also { remaining.add(p.getString("uuid")) } }
        assertThat(remaining).containsExactly("new")
    }
}
