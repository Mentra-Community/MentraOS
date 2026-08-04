package com.konovalov.vad.silero.config

/**
 * Created by Georgiy Konovalov on 6/2/2023.
 *
 * Enum class representing different Sample Rates used in the VAD algorithm.
 * @property value numeric value associated with the SampleRate.
 */
enum class SampleRate(val value:Int) {
    SAMPLE_RATE_8K(8000),
    SAMPLE_RATE_16K(16000);
}