package com.mentra.bluetoothsdk.stt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BoundedAudioQueueTest {
    private sealed class Item {
        data class Audio(val n: Int) : Item()
        data class Control(val name: String) : Item()
    }

    private fun queue(capacity: Int) = BoundedAudioQueue<Item>(capacity) { it is Item.Audio }

    @Test
    fun dropsOnlyTheOldestAudioWhenFull() {
        val q = queue(2)
        q.offer(Item.Audio(1))
        q.offer(Item.Control("finish"))
        q.offer(Item.Audio(2))
        val dropped = q.offer(Item.Audio(3))

        assertEquals(Item.Audio(1), dropped)
        assertEquals(1L, q.droppedAudio)
        assertEquals(Item.Control("finish"), q.poll(0))
        assertEquals(Item.Audio(2), q.poll(0))
        assertEquals(Item.Audio(3), q.poll(0))
        assertNull(q.poll(0))
    }

    @Test
    fun neverDropsControlItemsEvenWhenTheWorkerFallsBehind() {
        val q = queue(1)
        repeat(50) { i ->
            q.offer(Item.Control("c$i"))
            q.offer(Item.Audio(i))
        }
        val drained = q.drain()
        assertEquals(50, drained.count { it is Item.Control })
        // Only the newest audio frame fits.
        assertEquals(listOf(Item.Audio(49)), drained.filterIsInstance<Item.Audio>())
    }

    @Test
    fun keepsControlItemsInOrderAfterEarlierAudio() {
        val q = queue(10)
        q.offer(Item.Audio(1))
        q.offer(Item.Audio(2))
        q.offer(Item.Control("finish"))
        q.offer(Item.Audio(3))

        assertEquals(
            listOf(Item.Audio(1), Item.Audio(2), Item.Control("finish"), Item.Audio(3)),
            List(4) { q.poll(0) },
        )
    }

    @Test
    fun clearAudioKeepsControlItems() {
        val q = queue(10)
        q.offer(Item.Audio(1))
        q.offer(Item.Control("reset"))
        q.offer(Item.Audio(2))

        assertEquals(2, q.clearAudio())
        assertEquals(Item.Control("reset"), q.poll(0))
        assertNull(q.poll(0))
        // Capacity is available again after clearing.
        repeat(10) { q.offer(Item.Audio(it)) }
        assertEquals(0L, q.droppedAudio)
    }

    @Test
    fun pollTimesOutWhenEmpty() {
        val q = queue(1)
        val started = System.nanoTime()
        assertNull(q.poll(30))
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assert(elapsedMs >= 25) { "poll returned after ${elapsedMs}ms" }
    }
}
