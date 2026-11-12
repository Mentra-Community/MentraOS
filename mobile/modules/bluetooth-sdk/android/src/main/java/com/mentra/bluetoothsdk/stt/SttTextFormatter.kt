package com.mentra.bluetoothsdk.stt

import java.io.File

/**
 * Transcript casing, chosen from the vocabulary of the model that is actually loaded.
 *
 * Some streaming models (the original English Zipformer among them) only have upper-case
 * tokens, so they emit ALL-CAPS text; that output is lower-cased. Models whose vocabulary
 * has lower-case letters (Kroko, for example) produce their own casing and punctuation,
 * which is kept exactly. The decision never depends on a folder name or the selected path.
 */
internal object SttTextFormatter {
    enum class Casing {
        /** Keep the model's text as-is. */
        PRESERVE,

        /** The model only knows upper-case letters: lower-case its text. */
        LOWERCASE,
    }

    /** Casing for a model whose `tokens.txt` lines are [tokenLines]. */
    fun casingForTokens(tokenLines: Sequence<String>): Casing {
        var sawUpper = false
        for (line in tokenLines) {
            // tokens.txt lines are "<symbol> <id>"; only the symbol matters. Special
            // symbols such as <blk>, <unk> and byte tokens (<0x41>) never reach text.
            val trimmed = line.trim()
            val separator = trimmed.indexOfLast { it == ' ' || it == '\t' }
            val symbol = if (separator >= 0) trimmed.substring(0, separator) else trimmed
            if (symbol.startsWith('<') && symbol.endsWith('>')) continue
            for (ch in symbol) {
                if (ch.isLowerCase()) return Casing.PRESERVE
                if (ch.isUpperCase()) sawUpper = true
            }
        }
        return if (sawUpper) Casing.LOWERCASE else Casing.PRESERVE
    }

    /** Casing for the model directory [modelDir] (reads its `tokens.txt`). */
    fun casingForModel(modelDir: File): Casing {
        val tokens = File(modelDir, "tokens.txt")
        if (!tokens.isFile) return Casing.PRESERVE
        return tokens.bufferedReader().use { reader -> casingForTokens(reader.lineSequence()) }
    }

    fun format(text: String, casing: Casing): String =
        when (casing) {
            Casing.PRESERVE -> text
            Casing.LOWERCASE -> text.lowercase()
        }
}
