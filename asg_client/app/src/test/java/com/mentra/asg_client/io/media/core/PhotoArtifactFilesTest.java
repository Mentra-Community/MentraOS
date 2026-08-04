package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PhotoArtifactFilesTest {
    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void promoteToCanonicalReplacesUncroppedSource() throws Exception {
        File canonical = temporaryFolder.newFile("photo.jpg");
        File cropped = temporaryFolder.newFile("photo_textcrop.jpg");
        Files.write(canonical.toPath(), "uncropped".getBytes(StandardCharsets.UTF_8));
        byte[] expected = "cropped".getBytes(StandardCharsets.UTF_8);
        Files.write(cropped.toPath(), expected);

        PhotoArtifactFiles.promoteToCanonical(
                canonical.getAbsolutePath(), cropped.getAbsolutePath());

        assertArrayEquals(expected, Files.readAllBytes(canonical.toPath()));
        assertFalse(cropped.exists());
    }

    @Test
    public void cleanupWithoutSaveDeletesCanonicalAndTransportTemporary() throws Exception {
        File canonical = temporaryFolder.newFile("photo.jpg");
        File compressed = temporaryFolder.newFile("photo_compressed.jpg");

        PhotoArtifactFiles.cleanup(
                canonical.getAbsolutePath(), compressed.getAbsolutePath(), false);

        assertFalse(canonical.exists());
        assertFalse(compressed.exists());
    }

    @Test
    public void cleanupWithSaveKeepsOnlyCanonical() throws Exception {
        File canonical = temporaryFolder.newFile("photo.jpg");
        File compressed = temporaryFolder.newFile("photo_compressed.jpg");

        PhotoArtifactFiles.cleanup(
                canonical.getAbsolutePath(), compressed.getAbsolutePath(), true);

        assertTrue(canonical.exists());
        assertFalse(compressed.exists());
    }
}
