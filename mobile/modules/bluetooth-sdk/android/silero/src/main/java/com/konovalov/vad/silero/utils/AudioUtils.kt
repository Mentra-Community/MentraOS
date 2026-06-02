package com.konovalov.vad.silero.utils

/**
 * Created by Georgiy Konovalov on 7/18/2023.
 *
 * AudioUtils is a utility class that provides various functions to work with audio data
 * in different formats. It contains static methods that facilitate audio data conversions,
 * processing, and manipulation. This class aims to simplify common audio-related tasks
 * and ensure reusability of audio processing logic across the application.
 */
object AudioUtils {

    /**
     * Convert audio data from ByteArray to FloatArray.
     *
     * @param audio is audio data for conversion.
     * @return converted audio data as FloatArray.
     */
    fun toFloatArray(audio: ByteArray): FloatArray {
        return FloatArray(audio.size / 2) { i ->
            ((audio[2 * i].toInt() and 0xFF) or (audio[2 * i + 1].toInt() shl 8)) / 32767.0f
        }
    }

    /**
     * Convert audio data from ShortArray to FloatArray.
     *
     * @param audio is audio data for conversion.
     * @return converted audio data as FloatArray.
     */
    fun toFloatArray(audio: ShortArray): FloatArray {
        return FloatArray(audio.size) { i ->
            audio[i] / 32767.0f
        }
    }

    /**
     * Calculates the frame count based on the duration in milliseconds,
     * frequency and frame size.
     *
     * @param durationMs duration in milliseconds.
     * @return frame count.
     */
    fun getFramesCount(sampleRate: Int, frameSize: Int, durationMs: Int): Int {
        return durationMs / (frameSize / (sampleRate / 1000))
    }
}