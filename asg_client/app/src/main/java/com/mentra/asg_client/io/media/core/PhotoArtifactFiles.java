package com.mentra.asg_client.io.media.core;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** File lifecycle helpers for a captured photo and any transport-only derivative. */
final class PhotoArtifactFiles {
    private PhotoArtifactFiles() {}

    static void promoteToCanonical(String canonicalPath, String preparedPath) throws IOException {
        if (samePath(canonicalPath, preparedPath)) {
            return;
        }
        try {
            Files.move(
                    new File(preparedPath).toPath(),
                    new File(canonicalPath).toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException error) {
            deleteIfPresent(preparedPath);
            throw error;
        }
    }

    static void deleteTransportTemporary(String canonicalPath, String transportPath) {
        if (transportPath != null && !samePath(canonicalPath, transportPath)) {
            deleteIfPresent(transportPath);
        }
    }

    static void cleanup(String canonicalPath, String transportPath, boolean keepCanonical) {
        deleteTransportTemporary(canonicalPath, transportPath);
        if (!keepCanonical) {
            deleteIfPresent(canonicalPath);
        }
    }

    private static boolean samePath(String first, String second) {
        if (first == null || second == null) {
            return first == second;
        }
        return new File(first).getAbsoluteFile().equals(new File(second).getAbsoluteFile());
    }

    private static void deleteIfPresent(String path) {
        if (path == null) {
            return;
        }
        File file = new File(path);
        if (file.exists() && !file.delete()) {
            file.deleteOnExit();
        }
    }
}
