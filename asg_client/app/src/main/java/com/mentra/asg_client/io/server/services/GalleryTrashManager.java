package com.mentra.asg_client.io.server.services;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.utils.GallerySyncFilter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Implements the gallery source-deletion barrier.
 *
 * <p>Acknowledged captures are atomically renamed into a hidden trash directory when possible. They
 * remain restorable until a later, explicitly requested garbage-collection pass.
 */
final class GalleryTrashManager {

    private static final String ACKS_FILE = ".ack_ids";
    private static final String FLAT_LAYOUT_FILE = ".flat_layout";

    static final class Result {
        final boolean success;
        final boolean alreadyTrashed;
        final String captureId;
        final int fileCount;
        final long totalSize;
        final String message;

        Result(
                boolean success,
                boolean alreadyTrashed,
                String captureId,
                int fileCount,
                long totalSize,
                String message) {
            this.success = success;
            this.alreadyTrashed = alreadyTrashed;
            this.captureId = captureId;
            this.fileCount = fileCount;
            this.totalSize = totalSize;
            this.message = message;
        }
    }

    static final class TrashedCapture {
        final String captureId;
        final int fileCount;
        final long totalSize;
        final long trashedAt;

        TrashedCapture(String captureId, int fileCount, long totalSize, long trashedAt) {
            this.captureId = captureId;
            this.fileCount = fileCount;
            this.totalSize = totalSize;
            this.trashedAt = trashedAt;
        }
    }

    private final File packageDirectory;
    private final File trashDirectory;

    GalleryTrashManager(File packageDirectory) {
        this.packageDirectory = packageDirectory;
        this.trashDirectory = new File(packageDirectory, FileManager.GALLERY_TRASH_DIR_NAME);
    }

    synchronized Result trashCapture(String requestedId, String ackId) throws IOException {
        String captureId = validateCaptureId(requestedId);
        String validatedAckId = validateAckId(ackId);
        File destination = child(trashDirectory, captureId);
        if (destination.exists()) {
            // A process/power loss can interrupt the multi-file legacy layout after some files
            // have moved. Reconcile every exact capture member before reporting the retry as
            // acknowledged; otherwise the source could be split between live storage and trash.
            if (new File(destination, FLAT_LAYOUT_FILE).exists()) {
                moveFlatFiles(findFlatCaptureFiles(captureId), destination, false);
            }
            appendAck(destination, validatedAckId);
            Counts counts = countMedia(destination);
            touch(destination);
            return new Result(
                    true,
                    true,
                    captureId,
                    counts.files,
                    counts.bytes,
                    "Capture was already in recoverable trash");
        }

        ensureDirectory(trashDirectory);
        File liveDirectory = child(packageDirectory, captureId);
        if (liveDirectory.isDirectory()) {
            Counts counts = countMedia(liveDirectory);
            if (!liveDirectory.renameTo(destination)) {
                throw new IOException("Unable to move capture directory to recoverable trash");
            }
            appendAck(destination, validatedAckId);
            touch(destination);
            return new Result(
                    true,
                    false,
                    captureId,
                    counts.files,
                    counts.bytes,
                    "Capture moved to recoverable trash");
        }

        List<File> flatFiles = findFlatCaptureFiles(captureId);
        if (flatFiles.isEmpty()) {
            return new Result(false, false, captureId, 0, 0, "Capture was not found");
        }

        ensureDirectory(destination);
        writeMarker(new File(destination, FLAT_LAYOUT_FILE), "flat");
        Counts moved = moveFlatFiles(flatFiles, destination, true);
        appendAck(destination, validatedAckId);
        touch(destination);
        return new Result(
                true,
                false,
                captureId,
                moved.files,
                moved.bytes,
                "Capture moved to recoverable trash");
    }

    synchronized Result restoreCapture(String requestedId) throws IOException {
        String captureId = validateCaptureId(requestedId);
        File source = child(trashDirectory, captureId);
        if (!source.isDirectory()) {
            return new Result(false, false, captureId, 0, 0, "Capture is not in trash");
        }

        Counts counts = countMedia(source);
        if (new File(source, FLAT_LAYOUT_FILE).exists()) {
            for (File child : listFiles(source)) {
                if (isMetadata(child)) {
                    continue;
                }
                File target = child(packageDirectory, child.getName());
                if (target.exists() || !child.renameTo(target)) {
                    throw new IOException("Unable to restore " + child.getName());
                }
            }
            deleteRecursively(source);
        } else {
            deleteMetadata(source);
            File destination = child(packageDirectory, captureId);
            if (destination.exists() || !source.renameTo(destination)) {
                throw new IOException("Unable to restore capture directory");
            }
        }

        return new Result(true, false, captureId, counts.files, counts.bytes, "Capture restored");
    }

    synchronized List<TrashedCapture> listTrashed() throws IOException {
        if (!trashDirectory.isDirectory()) {
            return Collections.emptyList();
        }
        List<TrashedCapture> results = new ArrayList<>();
        for (File capture : listFiles(trashDirectory)) {
            if (!capture.isDirectory()) {
                continue;
            }
            Counts counts = countMedia(capture);
            results.add(
                    new TrashedCapture(
                            capture.getName(), counts.files, counts.bytes, capture.lastModified()));
        }
        results.sort(Comparator.comparingLong((TrashedCapture item) -> item.trashedAt).reversed());
        return results;
    }

    synchronized int garbageCollect(long minimumAgeMs) throws IOException {
        if (!trashDirectory.isDirectory()) {
            return 0;
        }
        long cutoff = System.currentTimeMillis() - Math.max(0, minimumAgeMs);
        int removed = 0;
        for (File capture : listFiles(trashDirectory)) {
            File acknowledgements = new File(capture, ACKS_FILE);
            if (capture.isDirectory()
                    && acknowledgements.isFile()
                    && acknowledgements.length() > 0
                    && capture.lastModified() <= cutoff) {
                deleteRecursively(capture);
                removed++;
            }
        }
        return removed;
    }

    private List<File> findFlatCaptureFiles(String captureId) {
        List<File> matches = new ArrayList<>();
        for (File file : listFiles(packageDirectory)) {
            if (file.isFile()
                    && captureId.equals(GallerySyncFilter.deriveCaptureId(file.getName()))) {
                matches.add(file);
            }
        }
        matches.sort(Comparator.comparing(File::getName));
        return matches;
    }

    private Counts moveFlatFiles(
            List<File> sources, File destination, boolean removeDestinationOnFailure)
            throws IOException {
        List<File> movedTargets = new ArrayList<>();
        long bytes = 0;
        try {
            for (File source : sources) {
                long sourceSize = source.length();
                File target = child(destination, source.getName());
                if (target.exists() || !source.renameTo(target)) {
                    throw new IOException(
                            "Unable to move " + source.getName() + " to recoverable trash");
                }
                movedTargets.add(target);
                bytes += sourceSize;
            }
            return new Counts(movedTargets.size(), bytes);
        } catch (IOException e) {
            for (int i = movedTargets.size() - 1; i >= 0; i--) {
                File moved = movedTargets.get(i);
                moved.renameTo(new File(packageDirectory, moved.getName()));
            }
            if (removeDestinationOnFailure) {
                deleteRecursivelyQuietly(destination);
            }
            throw e;
        }
    }

    private static String validateCaptureId(String captureId) {
        if (captureId == null || !captureId.matches("[A-Za-z0-9_-]+")) {
            throw new IllegalArgumentException("Invalid capture ID");
        }
        if (captureId.startsWith("_")) {
            throw new IllegalArgumentException("Reserved capture ID");
        }
        return captureId;
    }

    private static String validateAckId(String ackId) {
        if (ackId == null) {
            throw new IllegalArgumentException("Acknowledgement ID is required");
        }
        String value = ackId.trim();
        if (value.isEmpty() || value.contains("\n") || value.contains("\r")) {
            throw new IllegalArgumentException("Invalid acknowledgement ID");
        }
        return value;
    }

    private static void appendAck(File destination, String ackId) throws IOException {
        File marker = new File(destination, ACKS_FILE);
        String value = validateAckId(ackId) + "\n";
        try (FileOutputStream output = new FileOutputStream(marker, true)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
    }

    private static void deleteMetadata(File directory) throws IOException {
        for (File file : listFiles(directory)) {
            if (isMetadata(file) && !file.delete()) {
                throw new IOException("Unable to remove trash metadata");
            }
        }
    }

    private static boolean isMetadata(File file) {
        return ACKS_FILE.equals(file.getName()) || FLAT_LAYOUT_FILE.equals(file.getName());
    }

    private static Counts countMedia(File file) {
        if (file.isFile()) {
            return isMetadata(file) ? new Counts(0, 0) : new Counts(1, file.length());
        }
        int files = 0;
        long bytes = 0;
        for (File child : listFiles(file)) {
            Counts childCounts = countMedia(child);
            files += childCounts.files;
            bytes += childCounts.bytes;
        }
        return new Counts(files, bytes);
    }

    private static void writeMarker(File file, String value) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Unable to create " + directory.getName());
        }
    }

    private static File child(File parent, String name) throws IOException {
        File child = new File(parent, name);
        String parentPath = parent.getCanonicalPath() + File.separator;
        if (!child.getCanonicalPath().startsWith(parentPath)) {
            throw new IllegalArgumentException("Path escapes gallery storage");
        }
        return child;
    }

    private static File[] listFiles(File directory) {
        File[] files = directory.listFiles();
        return files != null ? files : new File[0];
    }

    private static void touch(File file) {
        file.setLastModified(System.currentTimeMillis());
    }

    private static void deleteRecursively(File file) throws IOException {
        if (file.isDirectory()) {
            for (File child : listFiles(file)) {
                deleteRecursively(child);
            }
        }
        if (file.exists() && !file.delete()) {
            throw new IOException("Unable to delete " + file.getName());
        }
    }

    private static void deleteRecursivelyQuietly(File file) {
        try {
            deleteRecursively(file);
        } catch (IOException ignored) {
            // Best effort rollback cleanup; original exception is more useful to the caller.
        }
    }

    private static final class Counts {
        final int files;
        final long bytes;

        Counts(int files, long bytes) {
            this.files = files;
            this.bytes = bytes;
        }
    }
}
