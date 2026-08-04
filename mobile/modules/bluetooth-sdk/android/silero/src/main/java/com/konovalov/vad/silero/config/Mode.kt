package com.konovalov.vad.silero.config

/**
 * Created by Georgiy Konovalov on 6/1/2023.
 *
 * Enum class representing different Modes used in the VAD algorithm.
 * @property value numeric value associated with the Mode.
 */
enum class Mode(val value: Int) {
    OFF(0),
    NORMAL(1),
    AGGRESSIVE(2),
    VERY_AGGRESSIVE(3);
}