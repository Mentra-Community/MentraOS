package com.mentra.asg_client.io.media.core.textdetect.roi;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

/** Loads ONNX models from a filesystem directory. */
public final class FileSystemModelSource implements ModelSource {
    private final Path directory;

    /**
     * Creates a filesystem model source.
     *
     * @param directory directory containing model assets
     */
    public FileSystemModelSource(Path directory) {
        this.directory = Objects.requireNonNull(directory, "directory").toAbsolutePath().normalize();
    }

    /** Loads the named file while preventing traversal outside the configured directory. */
    @Override
    public byte[] load(String assetName) throws IOException {
        Path modelPath = directory.resolve(assetName).normalize();
        if (!modelPath.startsWith(directory)) {
            throw new IOException("Model path escapes source directory: " + assetName);
        }
        return Files.readAllBytes(modelPath);
    }
}
