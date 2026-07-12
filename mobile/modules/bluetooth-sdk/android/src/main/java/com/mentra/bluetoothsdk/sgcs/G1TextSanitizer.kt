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
    return Normalizer.normalize(text.replace('Đ', 'D').replace('đ', 'd'), Normalizer.Form.NFD)
        .replace(G1_COMBINING_MARKS, "")
}
