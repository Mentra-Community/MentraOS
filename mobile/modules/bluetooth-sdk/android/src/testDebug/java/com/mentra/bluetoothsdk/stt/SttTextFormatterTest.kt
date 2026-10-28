package com.mentra.bluetoothsdk.stt

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class SttTextFormatterTest {
    private val text = "Hello, Mentra! I'm in New York."

    // Excerpts of real tokens.txt files.
    private val originalZipformerTokens =
        sequenceOf("<blk> 0", "<sos/eos> 1", "<unk> 2", "S 3", "▁THE 4", "▁A 5", "T 6", "'S 7")
    private val krokoTokens =
        sequenceOf("<blk> 0", "<unk> 1", "▁the 2", "▁I 3", "s 4", ", 5", ". 6", "▁New 7")

    @Test
    fun upperCaseOnlyVocabularyIsLowercased() {
        val casing = SttTextFormatter.casingForTokens(originalZipformerTokens)
        assertEquals(SttTextFormatter.Casing.LOWERCASE, casing)
        assertEquals("hello mentra", SttTextFormatter.format("HELLO MENTRA", casing))
    }

    @Test
    fun mixedCaseVocabularyKeepsTheModelsText() {
        val casing = SttTextFormatter.casingForTokens(krokoTokens)
        assertEquals(SttTextFormatter.Casing.PRESERVE, casing)
        assertEquals(text, SttTextFormatter.format(text, casing))
    }

    @Test
    fun specialTokensAloneDoNotDecide() {
        // <blk>/<unk> contain lower-case letters but never reach the transcript.
        assertEquals(
            SttTextFormatter.Casing.LOWERCASE,
            SttTextFormatter.casingForTokens(sequenceOf("<blk> 0", "<unk> 1", "▁HI 2", "<0x41> 3")),
        )
        assertEquals(
            SttTextFormatter.Casing.PRESERVE,
            SttTextFormatter.casingForTokens(sequenceOf("<blk> 0", "▁ 1", "1 2")),
        )
        // Tab-separated ids, as some tokens.txt files use.
        assertEquals(
            SttTextFormatter.Casing.LOWERCASE,
            SttTextFormatter.casingForTokens(sequenceOf("<blk>\t0", "▁HELLO\t1")),
        )
    }

    @Test
    fun casingComesFromTheModelFilesNotTheFolderName() {
        val root = Files.createTempDirectory("stt-format").toFile()
        try {
            // The original Zipformer under a folder named like Kroko still lowercases.
            val misnamed = File(root, "en-kroko").apply { mkdirs() }
            File(misnamed, "tokens.txt").writeText(originalZipformerTokens.joinToString("\n"))
            assertEquals(SttTextFormatter.Casing.LOWERCASE, SttTextFormatter.casingForModel(misnamed))

            val kroko = File(root, "en").apply { mkdirs() }
            File(kroko, "tokens.txt").writeText(krokoTokens.joinToString("\n"))
            assertEquals(SttTextFormatter.Casing.PRESERVE, SttTextFormatter.casingForModel(kroko))

            assertEquals(SttTextFormatter.Casing.PRESERVE, SttTextFormatter.casingForModel(File(root, "missing")))
        } finally {
            root.deleteRecursively()
        }
    }
}
