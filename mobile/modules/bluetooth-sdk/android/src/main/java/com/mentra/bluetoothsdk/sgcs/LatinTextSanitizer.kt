package com.mentra.bluetoothsdk.sgcs

import java.text.Normalizer

private val LATIN_COMBINING_MARKS = Regex("\\p{M}+")
private val LATIN_LETTERS_WITH_MARKS = Regex("\\p{IsLatin}\\p{M}*")

/** Converts accented and extended Latin letters to base glyphs at the device boundary. */
internal fun sanitizeLatinDisplayText(text: String, preserveOtherScripts: Boolean = false): String {
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

    if (preserveOtherScripts) {
        return LATIN_LETTERS_WITH_MARKS.replace(expanded) { match ->
            Normalizer.normalize(match.value, Normalizer.Form.NFD).replace(LATIN_COMBINING_MARKS, "")
        }
    }
    return Normalizer.normalize(expanded, Normalizer.Form.NFD)
        .replace(LATIN_COMBINING_MARKS, "")
}
