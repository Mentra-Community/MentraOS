package com.mentra.crust.utils

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class CanonicalFilePathTest {
    private lateinit var root: File

    @Before fun setUp() {
        root = Files.createTempDirectory("canonical-path-test").toFile().canonicalFile
    }

    @After fun tearDown() {
        root.deleteRecursively()
    }

    @Test fun `resolves dot segments and symlinks to the real location`() {
        val sandbox = File(root, "sandbox").apply { mkdirs() }
        val outside = File(root, "outside.txt").apply { writeText("secret") }
        val link = File(sandbox, "link.txt")
        Files.createSymbolicLink(link.toPath(), outside.toPath())

        assertEquals(outside.path, CanonicalFilePath.of(link.path))
        assertEquals(outside.path, CanonicalFilePath.of("${sandbox.path}/../outside.txt"))
        assertEquals(sandbox.path, CanonicalFilePath.of("${sandbox.path}/./"))
    }

    @Test fun `is null for a missing, relative or malformed path`() {
        assertNull(CanonicalFilePath.of("${root.path}/missing.txt"))
        assertNull(CanonicalFilePath.of("relative/path"))
        assertNull(CanonicalFilePath.of("${root.path}/a\u0000b"))
        assertNull(CanonicalFilePath.of(""))
    }
}
