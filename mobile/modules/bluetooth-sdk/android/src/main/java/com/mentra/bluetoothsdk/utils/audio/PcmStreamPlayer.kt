package com.mentra.bluetoothsdk.utils.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import java.util.ArrayDeque
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.max

/**
 * Live PCM chunk player for miniapp `speaker.createStream()`.
 *
 * One instance = one stream session. 16-bit LE PCM only. Unlike the SCO-tuned
 * [PCMAudioPlayer], this uses USAGE_MEDIA so the OS routes it like any media
 * playback (A2DP to connected glasses, else phone speaker).
 *
 * Threading: a dedicated feeder thread drains an in-memory chunk queue into a
 * MODE_STREAM AudioTrack (AudioTrack.write blocks there, not on callers).
 * `write` blocks the CALLING thread only while the backlog exceeds
 * [BACKPRESSURE_CEILING_MS] — call it from a background dispatcher. When the
 * track underruns (queue empty), AudioTrack plays silence and playback resumes
 * seamlessly on the next chunk; no stop/start pops.
 */
class PcmStreamPlayer(
        private val streamId: String,
        private val sampleRate: Int,
        channels: Int,
        volume: Float,
) {
    companion object {
        private const val TAG = "PcmStreamPlayer"

        /** write() blocks while more than this is queued but unplayed. */
        private const val BACKPRESSURE_CEILING_MS = 2_000L

        /** Hard cap — writes that would exceed this are rejected outright. */
        private const val MAX_BACKLOG_MS = 10_000L

        /** AudioTrack buffer: max(4x minimum, 500ms) of jitter headroom. */
        private const val TRACK_BUFFER_MS = 500
    }

    private val bytesPerFrame = 2 * channels
    private val channelMask =
            if (channels >= 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO

    private val lock = ReentrantLock()
    private val queueChanged = lock.newCondition()

    /** Pending chunks not yet handed to AudioTrack. Guarded by [lock]. */
    private val queue = ArrayDeque<ByteArray>()
    private var queuedBytes = 0L

    /** Total frames handed to AudioTrack.write. Guarded by [lock]. */
    private var framesWritten = 0L

    private var closing = false
    private var aborted = false
    private var writeInProgress = false
    private var released = false
    private var finalPlayedFrames: Long? = null
    private var endedError: String? = null

    private val audioTrack: AudioTrack
    private val feeder: Thread

    init {
        val minBuf =
                AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        val jitterBuf = sampleRate * bytesPerFrame * TRACK_BUFFER_MS / 1000
        audioTrack =
                AudioTrack.Builder()
                        .setAudioAttributes(
                                AudioAttributes.Builder()
                                        .setUsage(AudioAttributes.USAGE_MEDIA)
                                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                        .build()
                        )
                        .setAudioFormat(
                                AudioFormat.Builder()
                                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                        .setSampleRate(sampleRate)
                                        .setChannelMask(channelMask)
                                        .build()
                        )
                        .setBufferSizeInBytes(max(minBuf * 4, jitterBuf))
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()
        if (audioTrack.state != AudioTrack.STATE_INITIALIZED) {
            audioTrack.release()
            throw IllegalStateException("AudioTrack failed to initialize (rate=$sampleRate)")
        }
        audioTrack.setVolume(volume.coerceIn(0f, 1f))
        audioTrack.play()

        feeder =
                Thread({ feedLoop() }, "PcmStreamPlayer-$streamId").apply {
                    isDaemon = true
                    start()
                }
        Log.d(TAG, "[$streamId] opened: rate=$sampleRate ch=$channels vol=$volume")
    }

    /** Milliseconds of audio accepted but not yet played out. */
    private fun backlogMsLocked(): Long {
        val playedFrames = audioTrack.playbackHeadPosition.toLong() and 0xFFFFFFFFL
        val queuedFrames = queuedBytes / bytesPerFrame
        return max(0L, (framesWritten - playedFrames + queuedFrames)) * 1000L / sampleRate
    }

    /**
     * Append base64-encoded 16-bit LE PCM. Blocks while the backlog is above
     * the backpressure ceiling. Returns the backlog in ms after this chunk.
     */
    fun write(base64: String): Long {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        require(bytes.isNotEmpty()) { "PCM chunk is empty" }
        require(bytes.size % bytesPerFrame == 0) {
            "PCM chunk length ${bytes.size} is not aligned to a $bytesPerFrame-byte frame"
        }
        lock.withLock {
            check(!closing && !aborted) { "stream is closed" }
            endedError?.let { throw IllegalStateException(it) }
            check(backlogMsLocked() + bytes.size / bytesPerFrame * 1000L / sampleRate <= MAX_BACKLOG_MS) {
                "backlog exceeds ${MAX_BACKLOG_MS}ms — producer is not throttling"
            }
            queue.add(bytes)
            queuedBytes += bytes.size
            queueChanged.signalAll()
            // Backpressure: hold the caller until the feeder drains below the
            // ceiling. Caller is a background dispatcher, never the UI thread.
            while (backlogMsLocked() > BACKPRESSURE_CEILING_MS && !closing && !aborted && endedError == null) {
                queueChanged.await()
            }
            endedError?.let { throw IllegalStateException(it) }
            return backlogMsLocked()
        }
    }

    /**
     * Drain everything queued, then stop. Blocks until played out. Returns the
     * total played duration in ms.
     */
    fun close(): Long {
        lock.withLock {
            if (aborted) return playedMsLocked()
            closing = true
            queueChanged.signalAll()
            // Wait for the feeder to hand everything to the track...
            while ((queue.isNotEmpty() || writeInProgress) && endedError == null && !aborted) {
                queueChanged.await()
            }
        }
        // ...then for the track to play it out while AudioTrack is still in
        // PLAYSTATE_PLAYING. Calling stop() first flushes pending MODE_STREAM
        // audio on several Android builds and truncates the final chunk.
        try {
            val deadline = System.currentTimeMillis() + MAX_BACKLOG_MS
            while (System.currentTimeMillis() < deadline) {
                val drained =
                        lock.withLock {
                            val played = audioTrack.playbackHeadPosition.toLong() and 0xFFFFFFFFL
                            played >= framesWritten || endedError != null
                        }
                if (drained) break
                Thread.sleep(20)
            }
            audioTrack.stop()
        } catch (e: Exception) {
            Log.w(TAG, "[$streamId] drain-on-close failed", e)
        } finally {
            releaseInternals()
        }
        return playedMsLocked()
    }

    /** Stop now, dropping the backlog. Idempotent. */
    fun abort() {
        lock.withLock {
            if (aborted) return
            aborted = true
            queue.clear()
            queuedBytes = 0
            queueChanged.signalAll()
        }
        try {
            audioTrack.pause()
            audioTrack.flush()
        } catch (e: Exception) {
            Log.w(TAG, "[$streamId] abort flush failed", e)
        }
        releaseInternals()
        Log.d(TAG, "[$streamId] aborted")
    }

    /** Played duration so far, in ms. */
    fun playedMs(): Long = lock.withLock { playedMsLocked() }

    private fun playedMsLocked(): Long {
        val played =
                finalPlayedFrames
                        ?: try {
                            audioTrack.playbackHeadPosition.toLong() and 0xFFFFFFFFL
                        } catch (e: Exception) {
                            framesWritten
                        }
        return played * 1000L / sampleRate
    }

    private fun feedLoop() {
        try {
            while (true) {
                val chunk: ByteArray =
                        lock.withLock {
                            while (queue.isEmpty() && !closing && !aborted) {
                                queueChanged.await()
                            }
                            if (aborted) return
                            if (queue.isEmpty() && closing) return
                            queue.poll()!!.also { writeInProgress = true }
                        }
                // Blocking write OUTSIDE the lock so write()/abort() stay responsive.
                var off = 0
                while (off < chunk.size) {
                    val n = audioTrack.write(chunk, off, chunk.size - off)
                    if (n < 0) throw IllegalStateException("AudioTrack.write error $n")
                    off += n
                }
                lock.withLock {
                    queuedBytes -= chunk.size
                    framesWritten += chunk.size / bytesPerFrame
                    writeInProgress = false
                    queueChanged.signalAll()
                }
            }
        } catch (e: Exception) {
            if (!aborted) {
                Log.e(TAG, "[$streamId] feeder failed", e)
                lock.withLock {
                    endedError = e.message ?: "feeder failed"
                    queue.clear()
                    queuedBytes = 0
                    writeInProgress = false
                    queueChanged.signalAll()
                }
            }
        } finally {
            lock.withLock { queueChanged.signalAll() }
        }
    }

    private fun releaseInternals() {
        val shouldRelease =
                lock.withLock {
                    if (released) {
                        false
                    } else {
                        finalPlayedFrames =
                                try {
                                    audioTrack.playbackHeadPosition.toLong() and 0xFFFFFFFFL
                                } catch (_: Exception) {
                                    framesWritten
                                }
                        released = true
                        true
                    }
                }
        if (!shouldRelease) return
        try {
            audioTrack.release()
        } catch (e: Exception) {
            Log.w(TAG, "[$streamId] release failed", e)
        }
    }
}

/**
 * Registry of active [PcmStreamPlayer] sessions, keyed by streamId. All
 * methods are safe to call with unknown ids (write throws, abort no-ops) so
 * races with teardown resolve cleanly.
 */
object PcmStreamManager {
    private val players = java.util.concurrent.ConcurrentHashMap<String, PcmStreamPlayer>()

    fun open(streamId: String, sampleRate: Int, channels: Int, volume: Float) {
        require(streamId.isNotBlank()) { "streamId is required" }
        require(sampleRate == 16000 || sampleRate == 24000 || sampleRate == 48000) {
            "unsupported PCM sample rate $sampleRate"
        }
        require(channels == 1) { "only mono PCM is supported" }
        // Replacing an id is a caller bug, but never leak the old track.
        players.remove(streamId)?.abort()
        players[streamId] = PcmStreamPlayer(streamId, sampleRate, channels, volume)
    }

    fun write(streamId: String, base64: String): Long {
        val player =
                players[streamId] ?: throw IllegalStateException("pcm stream $streamId is not open")
        return player.write(base64)
    }

    fun close(streamId: String): Long {
        val player =
                players[streamId]
                        ?: throw IllegalStateException("pcm stream $streamId is not open")
        return try {
            player.close()
        } finally {
            // Leave a draining player addressable so teardown can still abort
            // it. The conditional remove preserves a replacement with the
            // same id if one was opened while this close was completing.
            players.remove(streamId, player)
        }
    }

    fun abort(streamId: String) {
        players.remove(streamId)?.abort()
    }

    fun abortAll() {
        val active = players.values.toList()
        players.clear()
        active.forEach { it.abort() }
    }
}
