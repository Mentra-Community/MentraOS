package com.mentra.bluetoothsdk.utils.audio

import com.mentra.bluetoothsdk.utils.NativeLog as Log
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * A URL playback failure. [code] is "aborted", "http_error" (non-2xx), "unsupported_format"
 * (compressed audio instead of raw PCM) or "network_error".
 */
class PcmUrlPlaybackException(val code: String, message: String, cause: Throwable? = null) :
        Exception(message, cause)

/**
 * Re-frames a byte stream into whole 16-bit samples: a trailing odd byte is carried over
 * to the next chunk instead of being written (or dropped) mid-sample.
 */
internal class Pcm16ByteCarry {
    private var pending = -1

    /** Whether a byte is waiting for its pair. */
    val hasPendingByte: Boolean
        get() = pending >= 0

    /** Whole samples from the carried byte plus `buffer[0, length)`, or null if none. */
    fun push(buffer: ByteArray, length: Int): ByteArray? {
        if (length <= 0) return null
        val carried = if (pending >= 0) 1 else 0
        val total = carried + length
        val even = total - (total % 2)
        if (even == 0) {
            pending = buffer[0].toInt() and 0xff
            return null
        }
        val out = ByteArray(even)
        var start = 0
        if (carried == 1) {
            out[0] = pending.toByte()
            start = 1
        }
        System.arraycopy(buffer, 0, out, start, even - start)
        pending = if (total % 2 == 1) buffer[length - 1].toInt() and 0xff else -1
        return out
    }
}

/**
 * One `pcmStreamPlayUrl` request: an HTTP GET whose body is raw s16le mono PCM, written
 * into a [PcmStreamPlayer] as it arrives. Audio never crosses into JavaScript.
 */
internal class PcmUrlPlayback(
        private val url: String,
        private val onPlayer: (PcmStreamPlayer) -> Unit,
) {
    companion object {
        private const val TAG = "PcmUrlPlayback"
        private const val READ_BUFFER_BYTES = 8 * 1024

        /**
         * Compressed audio would play as noise. Same list as iOS; anything else (audio/L16,
         * audio/pcm, application/octet-stream, no type) is played as raw PCM.
         */
        private val COMPRESSED_CONTENT_TYPES =
                setOf("audio/mpeg", "audio/mp3", "audio/aac", "audio/ogg", "audio/opus", "audio/webm")

        /** The media type of a Content-Type header, lower-cased and without parameters. */
        internal fun mediaType(contentType: String?): String? =
                contentType?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }

        internal fun isCompressedAudio(contentType: String?): Boolean =
                mediaType(contentType) in COMPRESSED_CONTENT_TYPES

        private val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(20, TimeUnit.SECONDS)
                    .build()
        }

        /** Copy [input] to [write] in whole samples. Returns the bytes written. */
        internal fun pump(input: InputStream, write: (ByteArray) -> Unit): Long {
            val carry = Pcm16ByteCarry()
            val buffer = ByteArray(READ_BUFFER_BYTES)
            var written = 0L
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                val chunk = carry.push(buffer, n) ?: continue
                write(chunk)
                written += chunk.size
            }
            if (carry.hasPendingByte) Log.w(TAG, "response ended mid-sample; dropped 1 byte")
            return written
        }
    }

    @Volatile private var cancelled = false
    @Volatile private var call: Call? = null

    @Volatile
    var player: PcmStreamPlayer? = null
        private set

    /** Stop the download and the audio. [run] then throws code "aborted". */
    fun cancel() {
        cancelled = true
        call?.cancel()
        player?.abort()
    }

    private fun aborted() = PcmUrlPlaybackException("aborted", "aborted")

    private fun downloadFailed(error: Exception) =
            PcmUrlPlaybackException(
                    "network_error",
                    "PCM stream download failed: ${error.message ?: error.javaClass.simpleName}",
                    error,
            )

    /**
     * Download and play. Blocks until the body has played; returns the played ms.
     * [makePlayer] runs once the response headers arrived with a 2xx status.
     */
    fun run(makePlayer: () -> PcmStreamPlayer): Long {
        if (cancelled) throw aborted()
        val request = Request.Builder().url(url).get().build()
        val pending = client.newCall(request)
        call = pending
        if (cancelled) throw aborted()
        val response =
                try {
                    pending.execute()
                } catch (e: IOException) {
                    if (cancelled) throw aborted()
                    throw downloadFailed(e)
                }
        response.use {
            if (!response.isSuccessful) {
                throw PcmUrlPlaybackException(
                        "http_error",
                        "PCM stream request failed with HTTP ${response.code}",
                )
            }
            val contentType = response.header("Content-Type")
            if (isCompressedAudio(contentType)) {
                throw PcmUrlPlaybackException(
                        "unsupported_format",
                        "PCM stream URL returned ${mediaType(contentType)}, not raw PCM",
                )
            }
            val body = response.body ?: throw PcmUrlPlaybackException("http_error", "empty response body")
            val output = makePlayer()
            player = output
            onPlayer(output)
            if (cancelled) {
                output.abort()
                throw aborted()
            }
            var failure: Exception? = null
            try {
                pump(body.byteStream()) { chunk -> output.writePcm(chunk) }
            } catch (e: Exception) {
                failure = e
            }
            if (cancelled) throw aborted()
            // Play out what arrived, including after a dropped connection.
            val playedMs = output.close()
            if (cancelled) throw aborted()
            failure?.let { error -> throw downloadFailed(error) }
            return playedMs
        }
    }
}
