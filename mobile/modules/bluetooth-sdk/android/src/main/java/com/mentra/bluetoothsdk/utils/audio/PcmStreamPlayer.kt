package com.mentra.bluetoothsdk.utils.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.util.Base64
import com.mentra.bluetoothsdk.utils.NativeLog as Log
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
class PcmStreamPlayer
@JvmOverloads
constructor(
        private val streamId: String,
        private val sampleRate: Int,
        channels: Int,
        volume: Float,
        jitterMs: Int = TRACK_BUFFER_MS,
        /**
         * Abort this stream if the audio route changes before its first write (see
         * [PcmStreamManager.abortStreamsWithoutAudio]). False for streams fed natively.
         */
        internal val abortOnRouteChangeBeforeAudio: Boolean = true,
) {
    companion object {
        private const val TAG = "PcmStreamPlayer"

        /** write() blocks while more than this is queued but unplayed. */
        private const val BACKPRESSURE_CEILING_MS = 2_000L

        /** Hard cap — writes that would exceed this are rejected outright. */
        private const val MAX_BACKLOG_MS = 10_000L

        /** Default playout headroom, which is also how much audio is queued before playback starts. */
        internal const val TRACK_BUFFER_MS = 500

        /**
         * Floor on the requested headroom.
         *
         * A MODE_STREAM track fills to its buffer size and stays there, so this value is also the
         * steady-state output latency, not just a jitter cushion. Callers that want a conversation
         * to feel live ask for a small number; below this the feeder cannot outrun playback and the
         * track underruns into audible chop, which is worse than the delay it buys back.
         */
        private const val MIN_TRACK_BUFFER_MS = 80
    }

    /**
     * Playout headroom, and therefore this stream's floor latency.
     *
     * [TRACK_BUFFER_MS] suits one-way media (a miniapp `speaker.createStream()` clip), where half a
     * second of cushion costs nothing audible. A realtime call is the opposite trade: that same
     * cushion is half a second of delay before the far end's voice reaches the wearer, so the ACS
     * meeting path asks for a much smaller one.
     */
    private val jitterBufferMs = jitterMs.coerceIn(MIN_TRACK_BUFFER_MS, TRACK_BUFFER_MS)

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

    /** False until the first chunk is accepted. Guarded by [lock]. */
    private var receivedAudio = false

    /** Route generation when the stream opened ([AudioRouteWatcher]). */
    internal val openedRouteGeneration: Long = AudioRouteWatcher.currentGeneration()

    private val audioTrack: AudioTrack
    private val feeder: Thread
    @Volatile private var playbackStarted = false

    init {
        val minBuf =
                AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        val jitterBuf = sampleRate * bytesPerFrame * jitterBufferMs / 1000
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
                        // minBuf is AudioTrack's own floor, so it wins over a smaller request; the
                        // requested headroom is otherwise authoritative. Any fixed multiple of
                        // minBuf here would silently override a caller asking for low latency,
                        // since minBuf scales with the rate while the request does not.
                        .setBufferSizeInBytes(max(minBuf, jitterBuf))
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()
        if (audioTrack.state != AudioTrack.STATE_INITIALIZED) {
            audioTrack.release()
            throw IllegalStateException("AudioTrack failed to initialize (rate=$sampleRate)")
        }
        audioTrack.setVolume(volume.coerceIn(0f, 1f))
        // An allocated cue may wait silently for a wake. Start only when its
        // first PCM arrives, so prewarming does not activate Bluetooth output.
        feeder =
                Thread({ feedLoop() }, "PcmStreamPlayer-$streamId").apply {
                    isDaemon = true
                    start()
                }
        Log.d(
                TAG,
                "[$streamId] opened: rate=$sampleRate ch=$channels vol=$volume " +
                        "jitterMs=$jitterBufferMs trackBytes=${max(minBuf, jitterBuf)}",
        )
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
    fun write(base64: String): Long = writePcm(Base64.decode(base64, Base64.DEFAULT))

    /** Whether any audio has been written yet. */
    val hasReceivedAudio: Boolean
        get() = lock.withLock { receivedAudio }

    /**
     * Append raw 16-bit LE PCM. Blocks while the backlog is above the backpressure
     * ceiling. Returns the backlog in ms after this chunk.
     */
    fun writePcm(bytes: ByteArray): Long {
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
            receivedAudio = true
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
     *
     * Playback starts once the track's buffer (the jitter headroom) is full. A
     * stream shorter than that is topped up with silence here, so a short sound
     * still plays instead of waiting for audio that will never come.
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
            if (aborted) return playedMsLocked()
        }
        if (!playbackStarted) {
            // Nothing was ever written (a prewarmed stream closed unused).
            releaseInternals()
            return 0
        }
        try {
            startShortStream()
        } catch (e: Exception) {
            Log.w(TAG, "[$streamId] could not start a short stream", e)
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
        // Silence padding a short stream may have played past the real audio.
        return lock.withLock { minOf(playedMsLocked(), framesWritten * 1000L / sampleRate) }
    }

    /**
     * Write silence up to the track's start threshold when less audio than that was
     * written, so the track starts. Only called from [close] once the feeder is done.
     */
    private fun startShortStream() {
        val written = lock.withLock { framesWritten }
        val threshold =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioTrack.startThresholdInFrames
                } else {
                    audioTrack.bufferSizeInFrames
                }.toLong()
        val padFrames = threshold - written
        if (written <= 0 || padFrames <= 0) return
        val silence = ByteArray((padFrames * bytesPerFrame).toInt())
        var off = 0
        while (off < silence.size) {
            val n = audioTrack.write(silence, off, silence.size - off)
            if (n <= 0) break
            off += n
        }
    }

    /**
     * Abort if no audio has been written yet (for example a prewarmed stream when the
     * audio route changes). Returns whether it aborted.
     */
    internal fun abortIfNoAudio(): Boolean {
        lock.withLock {
            if (receivedAudio || closing || aborted) return false
            markAbortedLocked()
        }
        stopAndRelease()
        return true
    }

    /** Stop now, dropping the backlog. Idempotent. */
    fun abort() {
        lock.withLock {
            if (aborted) return
            markAbortedLocked()
        }
        stopAndRelease()
    }

    private fun markAbortedLocked() {
        aborted = true
        queue.clear()
        queuedBytes = 0
        queueChanged.signalAll()
    }

    private fun stopAndRelease() {
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
                // The track can be allocated ahead of time without starting an
                // empty output stream or elevating the glasses microphone gate.
                if (!playbackStarted) {
                    audioTrack.play()
                    playbackStarted = true
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
 *
 * A stream that hasn't received audio yet (for example one prewarmed before a
 * wake word) is aborted when the audio route changes, so its next write fails
 * with "not open" and the caller reopens on the current route instead of
 * playing on a stale one. See [AudioRouteWatcher].
 */
object PcmStreamManager {
    private const val TAG = "PcmStreamManager"
    private val players = java.util.concurrent.ConcurrentHashMap<String, PcmStreamPlayer>()
    private val urlPlaybacks = java.util.concurrent.ConcurrentHashMap<String, PcmUrlPlayback>()

    private fun validate(streamId: String, sampleRate: Int, channels: Int) {
        require(streamId.isNotBlank()) { "streamId is required" }
        require(sampleRate == 16000 || sampleRate == 24000 || sampleRate == 48000) {
            "unsupported PCM sample rate $sampleRate"
        }
        require(channels == 1) { "only mono PCM is supported" }
    }

    private fun notOpen(streamId: String) = IllegalStateException("pcm stream $streamId is not open")

    fun open(streamId: String, sampleRate: Int, channels: Int, volume: Float, jitterMs: Int? = null) {
        validate(streamId, sampleRate, channels)
        AudioRouteWatcher.ensureStarted()
        // Replacing an id is a caller bug, but never leak the old track.
        urlPlaybacks.remove(streamId)?.cancel()
        players.remove(streamId)?.abort()
        players[streamId] =
                if (jitterMs == null) {
                    PcmStreamPlayer(streamId, sampleRate, channels, volume)
                } else {
                    PcmStreamPlayer(streamId, sampleRate, channels, volume, jitterMs)
                }
    }

    fun write(streamId: String, base64: String): Long {
        val player = players[streamId] ?: throw notOpen(streamId)
        // A route change since open that no listener reported yet (for example a call
        // starting on Android < 12) still invalidates a stream that has no audio.
        if (player.abortOnRouteChangeBeforeAudio &&
                        !player.hasReceivedAudio &&
                        AudioRouteWatcher.currentGeneration() != player.openedRouteGeneration &&
                        player.abortIfNoAudio()
        ) {
            players.remove(streamId, player)
            Log.d(TAG, "[$streamId] aborted before its first write: the audio route changed")
            throw notOpen(streamId)
        }
        return player.write(base64)
    }

    fun close(streamId: String): Long {
        val player =
                players[streamId]
                        ?: throw notOpen(streamId)
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
        urlPlaybacks.remove(streamId)?.cancel()
        players.remove(streamId)?.abort()
    }

    fun abortAll() {
        val playbacks = urlPlaybacks.values.toList()
        urlPlaybacks.clear()
        playbacks.forEach { it.cancel() }
        val active = players.values.toList()
        players.clear()
        active.forEach { it.abort() }
    }

    /** Abort every stream that hasn't received audio yet. Called on an audio route change. */
    internal fun abortStreamsWithoutAudio(reason: String) {
        for ((streamId, player) in players) {
            if (player.abortOnRouteChangeBeforeAudio && player.abortIfNoAudio()) {
                players.remove(streamId, player)
                Log.d(TAG, "[$streamId] aborted before its first write: $reason")
            }
        }
    }

    /**
     * Fetch [url] and play its body (raw 16-bit LE mono PCM at [sampleRate]) as it
     * arrives, through a [PcmStreamPlayer] registered under [streamId]. Blocks the
     * calling (background) thread until the whole body has played and returns the
     * played duration in ms. Throws [PcmUrlPlaybackException]: code "aborted" after
     * [abort], "http_error" on a non-2xx response, "unsupported_format" for
     * compressed audio, "network_error" when the connection fails (audio already
     * received still plays out first).
     */
    fun playUrl(streamId: String, url: String, sampleRate: Int, volume: Float, jitterMs: Int?): Long {
        validate(streamId, sampleRate, 1)
        val playback =
                PcmUrlPlayback(url) { player ->
                    // Register so pcmStreamAbort(streamId) and teardown reach the player.
                    players.put(streamId, player)?.abort()
                }
        urlPlaybacks.put(streamId, playback)?.cancel()
        players.remove(streamId)?.abort()
        try {
            return playback.run {
                PcmStreamPlayer(
                        streamId,
                        sampleRate,
                        1,
                        volume,
                        jitterMs ?: PcmStreamPlayer.TRACK_BUFFER_MS,
                        abortOnRouteChangeBeforeAudio = false,
                )
            }
        } finally {
            urlPlaybacks.remove(streamId, playback)
            playback.player?.let { players.remove(streamId, it) }
        }
    }
}
