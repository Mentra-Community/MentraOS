package com.mentra.core.testing

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.mentra.core.CoreManager

/**
 * BroadcastReceiver for E2E testing that allows injecting test audio via ADB.
 *
 * Usage from command line:
 *   adb shell am broadcast -a com.mentra.TEST_INJECT_AUDIO \
 *       --es filePath "/sdcard/Download/mentra-test/hello-world.wav" \
 *       -n com.mentra.mentra/com.mentra.core.testing.TestAudioReceiver
 *
 * This receiver is only active in debug builds.
 */
class TestAudioReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "TestAudioReceiver"
        const val ACTION_INJECT_AUDIO = "com.mentra.TEST_INJECT_AUDIO"
        const val EXTRA_FILE_PATH = "filePath"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_INJECT_AUDIO) {
            Log.w(TAG, "Received unknown action: ${intent.action}")
            return
        }

        val filePath = intent.getStringExtra(EXTRA_FILE_PATH)
        if (filePath.isNullOrEmpty()) {
            Log.e(TAG, "No filePath provided in intent")
            return
        }

        Log.d(TAG, "Received request to inject audio from: $filePath")

        try {
            injectAudioFromFile(filePath)
            Log.d(TAG, "Audio injection started successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to inject audio: ${e.message}", e)
        }
    }

    private fun injectAudioFromFile(filePath: String) {
        val file = java.io.File(filePath)
        if (!file.exists()) {
            Log.e(TAG, "File not found: $filePath")
            return
        }

        // Read WAV file
        val inputStream = java.io.FileInputStream(file)
        val wavData = inputStream.readBytes()
        inputStream.close()

        // Parse WAV header
        if (wavData.size < 44) {
            Log.e(TAG, "Invalid WAV file: too small")
            return
        }

        // Verify WAV header
        val riff = String(wavData.sliceArray(0..3))
        val wave = String(wavData.sliceArray(8..11))
        if (riff != "RIFF" || wave != "WAVE") {
            Log.e(TAG, "Invalid WAV file: not a valid WAV format")
            return
        }

        // Extract format info
        val byteBuffer = java.nio.ByteBuffer.wrap(wavData).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val numChannels = byteBuffer.getShort(22).toInt()
        val sampleRate = byteBuffer.getInt(24)
        val bitsPerSample = byteBuffer.getShort(34).toInt()

        Log.d(TAG, "WAV: channels=$numChannels, sampleRate=$sampleRate, bits=$bitsPerSample")

        if (bitsPerSample != 16) {
            Log.e(TAG, "Unsupported bits per sample: $bitsPerSample (need 16)")
            return
        }

        // Find data chunk
        var dataOffset = 12
        while (dataOffset < wavData.size - 8) {
            val chunkId = String(wavData.sliceArray(dataOffset until dataOffset + 4))
            val chunkSize = byteBuffer.getInt(dataOffset + 4)
            if (chunkId == "data") {
                dataOffset += 8
                break
            }
            dataOffset += 8 + chunkSize
        }

        val pcmData = wavData.sliceArray(dataOffset until wavData.size)
        Log.d(TAG, "PCM data size: ${pcmData.size} bytes")

        // Chunk size for ~20ms of audio at 16kHz mono 16-bit = 640 bytes
        // For stereo, we need to read 2x as many bytes to get 20ms of audio
        val monoChunkSize = 640
        val rawChunkSize = monoChunkSize * numChannels

        // Use precise timing to match real-time playback
        // 640 bytes @ 16kHz 16-bit mono = 20ms of audio
        val chunkDurationNs = 20_000_000L  // 20ms in nanoseconds

        // Inject PCM data in chunks on background thread with real-time pacing
        Thread {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)

            var offset = 0
            var chunkCount = 0
            val coreManager = CoreManager.getInstance()
            var nextChunkTime = System.nanoTime()

            while (offset < pcmData.size) {
                val end = minOf(offset + rawChunkSize, pcmData.size)
                val chunk = pcmData.sliceArray(offset until end)

                // If stereo, extract left channel only (samples are interleaved: L R L R ...)
                val monoChunk = if (numChannels == 2) {
                    // Each sample is 2 bytes (16-bit), stereo has L/R pairs = 4 bytes per sample pair
                    val mono = ByteArray(chunk.size / 2)
                    var monoIdx = 0
                    var stereoIdx = 0
                    while (stereoIdx < chunk.size - 3 && monoIdx < mono.size - 1) {
                        // Copy left channel sample (2 bytes)
                        mono[monoIdx] = chunk[stereoIdx]
                        mono[monoIdx + 1] = chunk[stereoIdx + 1]
                        monoIdx += 2
                        stereoIdx += 4  // Skip right channel
                    }
                    mono.sliceArray(0 until monoIdx)
                } else {
                    chunk
                }

                if (monoChunk.isNotEmpty()) {
                    coreManager.handlePcm(monoChunk)
                    chunkCount++
                }
                offset = end

                // Precise timing: wait until next chunk should be sent
                nextChunkTime += chunkDurationNs
                val sleepNs = nextChunkTime - System.nanoTime()
                if (sleepNs > 0) {
                    Thread.sleep(sleepNs / 1_000_000, (sleepNs % 1_000_000).toInt())
                }
            }
            Log.d(TAG, "Audio injection complete: $chunkCount chunks sent")
        }.start()
    }
}
