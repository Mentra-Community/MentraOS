package com.mentra.bluetoothsdk.sgcs

import java.text.Normalizer

private val G1_COMBINING_MARKS = Regex("\\p{M}+")

/**
 * Converts text to the base Latin glyphs available in the Even Realities G1 firmware.
 *
 * G1 does not ship glyphs for combining diacritics. Normalize at the device boundary so
 * miniapps can retain the real text everywhere else and newer glasses receive it unchanged.
 */
internal fun sanitizeG1DisplayText(text: String): String {
    val expanded = buildString(text.length) {
        text.forEach { character ->
            when (character) {
                'Đ', 'Ð' -> append('D')
                'đ', 'ð' -> append('d')
                'Ł' -> append('L')
                'ł' -> append('l')
                'Ø' -> append('O')
                'ø' -> append('o')
                'Æ' -> append("AE")
                'æ' -> append("ae")
                'Œ' -> append("OE")
                'œ' -> append("oe")
                'ẞ' -> append("SS")
                'ß' -> append("ss")
                'Þ' -> append("TH")
                'þ' -> append("th")
                else -> append(character)
            }
        }
    }

    return Normalizer.normalize(expanded, Normalizer.Form.NFD)
        .replace(G1_COMBINING_MARKS, "")
}
