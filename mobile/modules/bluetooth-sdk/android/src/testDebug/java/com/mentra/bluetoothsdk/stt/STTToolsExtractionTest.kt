package com.mentra.bluetoothsdk.stt

import java.io.File
import java.nio.file.Files
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorOutputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class STTToolsExtractionTest {
    private val root = Files.createTempDirectory("stt-extract").toFile()

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    private fun archive(name: String, entries: Map<String, ByteArray>, truncateTo: Int? = null): File {
        val file = File(root, name)
        TarArchiveOutputStream(BZip2CompressorOutputStream(file.outputStream())).use { tar ->
            for ((path, data) in entries) {
                val entry = TarArchiveEntry(path)
                entry.size = data.size.toLong()
                tar.putArchiveEntry(entry)
                tar.write(data)
                tar.closeArchiveEntry()
            }
        }
        if (truncateTo != null) {
            val bytes = file.readBytes()
            file.writeBytes(bytes.copyOf(truncateTo))
        }
        return file
    }

    private fun leftovers() = root.listFiles()!!.filter { it.name.contains(".extracting-") }

    @Test
    fun extractsIntoPlaceAndFlattensTheTopLevelDirectory() {
        val source =
            archive(
                "model.tar.bz2",
                mapOf(
                    "sherpa-model/tokens.txt" to "a 0\n".toByteArray(),
                    "sherpa-model/encoder-epoch-99-avg-1.onnx" to ByteArray(1000) { 1 },
                ),
            )
        val dest = File(root, "models/en")

        assertTrue(STTTools.extractTarBz2(source.absolutePath, dest.absolutePath))
        assertEquals("a 0\n", File(dest, "tokens.txt").readText())
        assertEquals(1000L, File(dest, "encoder.onnx").length())
        assertFalse(File(dest, "sherpa-model").exists())
        assertTrue(leftovers().isEmpty() && File(root, "models").listFiles()!!.size == 1)
    }

    @Test
    fun aTruncatedArchiveLeavesNoPartialModelBehind() {
        val big = ByteArray(400_000) { (it % 251).toByte() }
        val source = archive("broken.tar.bz2", mapOf("m/tokens.txt" to "a 0\n".toByteArray(), "m/model.onnx" to big))
        source.writeBytes(source.readBytes().copyOf(source.length().toInt() / 2))
        val dest = File(root, "models/fr")

        assertFalse(STTTools.extractTarBz2(source.absolutePath, dest.absolutePath))
        assertFalse("a partial extract must not be visible", dest.exists())
        assertTrue(File(root, "models").listFiles().orEmpty().isEmpty())
    }

    @Test
    fun aFailedExtractKeepsTheExistingModel() {
        val dest = File(root, "models/de").apply { mkdirs() }
        File(dest, "tokens.txt").writeText("old")
        val missing = File(root, "missing.tar.bz2")

        assertFalse(STTTools.extractTarBz2(missing.absolutePath, dest.absolutePath))
        assertEquals("old", File(dest, "tokens.txt").readText())
    }

    @Test
    fun aSuccessfulExtractReplacesTheExistingModel() {
        val dest = File(root, "models/es").apply { mkdirs() }
        File(dest, "stale.onnx").writeText("stale")
        val source = archive("es.tar.bz2", mapOf("es/tokens.txt" to "b 0\n".toByteArray()))

        assertTrue(STTTools.extractTarBz2(source.absolutePath, dest.absolutePath))
        assertEquals("b 0\n", File(dest, "tokens.txt").readText())
        assertFalse(File(dest, "stale.onnx").exists())
    }

    @Test
    fun rejectsEntriesThatEscapeTheDestination() {
        val source = archive("evil.tar.bz2", mapOf("../evil.txt" to "x".toByteArray()))
        val dest = File(root, "models/x")

        assertFalse(STTTools.extractTarBz2(source.absolutePath, dest.absolutePath))
        assertFalse(File(root, "models/evil.txt").exists())
        assertFalse(dest.exists())
    }
}
