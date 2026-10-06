package com.mentra.bluetoothsdk.sgcs

import java.text.Normalizer

private val LATIN_COMBINING_MARKS = Regex("\\p{M}+")

/** G1 uses the shared Latin fallback without applying other devices' punctuation fixes. */
internal fun sanitizeG1DisplayText(text: String): String = sanitizeLatinDisplayText(text)

/** Converts accented and extended Latin letters to base glyphs at the device boundary. */
internal fun sanitizeLatinDisplayText(text: String): String {
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
        .replace(LATIN_COMBINING_MARKS, "")
}
