package com.mentra.bluetoothsdk.stt

import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * FIFO work queue for a speech worker thread.
 *
 * Audio frames are bounded: when [audioCapacity] frames are already waiting, the oldest
 * waiting frame is dropped. Control items (load, configure, finish, release) are never
 * dropped, so a caller waiting on one can't wait forever because the worker fell behind.
 * Order between audio and control items is preserved, so a control item runs after every
 * frame queued before it.
 */
internal class BoundedAudioQueue<T : Any>(
    private val audioCapacity: Int,
    private val isAudio: (T) -> Boolean,
) {
    init {
        require(audioCapacity > 0) { "audioCapacity must be positive" }
    }

    private val lock = ReentrantLock()
    private val changed = lock.newCondition()
    private val items = ArrayDeque<T>()
    private var audioCount = 0

    /** Total audio frames dropped because the worker fell behind. */
    var droppedAudio = 0L
        private set

    /** Enqueue [item]. Returns the audio frame dropped to make room, if any. */
    fun offer(item: T): T? =
        lock.withLock {
            var dropped: T? = null
            if (isAudio(item)) {
                if (audioCount >= audioCapacity) {
                    val iterator = items.iterator()
                    while (iterator.hasNext()) {
                        val queued = iterator.next()
                        if (isAudio(queued)) {
                            iterator.remove()
                            audioCount--
                            droppedAudio++
                            dropped = queued
                            break
                        }
                    }
                }
                audioCount++
            }
            items.addLast(item)
            changed.signalAll()
            dropped
        }

    /** Next item, waiting up to [timeoutMs]; null on timeout. */
    fun poll(timeoutMs: Long): T? =
        lock.withLock {
            var remainingNanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (items.isEmpty()) {
                if (remainingNanos <= 0L) return null
                remainingNanos = changed.awaitNanos(remainingNanos)
            }
            val item = items.removeFirst()
            if (isAudio(item)) audioCount--
            item
        }

    /** Remove every waiting audio frame, keeping control items. */
    fun clearAudio(): Int =
        lock.withLock {
            val before = items.size
            items.removeAll { isAudio(it) }
            audioCount = 0
            before - items.size
        }

    /** Remove and return everything waiting. */
    fun drain(): List<T> =
        lock.withLock {
            val all = items.toList()
            items.clear()
            audioCount = 0
            all
        }

    val size: Int
        get() = lock.withLock { items.size }
}
