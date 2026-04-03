package com.mentra.asg_client.utils;

import com.mentra.asg_client.io.file.core.FileManager.FileMetadata;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Shared rules for which filesystem captures count as user-visible gallery items.
 * A capture is valid only if it contains {@code base.jpg}, {@code base.jpeg}, or {@code base.mp4}
 * under a folder (HDR brackets alone do not qualify until {@code base.jpg} exists).
 */
public final class CaptureGalleryRules {

    /** Minimum age of newest file in an orphan capture before deletion (HDR-safe). */
    public static final long STALE_ORPHAN_MS = 10 * 60 * 1000L;

    /** Minimum interval between orphan cleanup runs (latency bound). */
    public static final long CLEANUP_THROTTLE_MS = 5 * 60 * 1000L;

    private CaptureGalleryRules() {}

    public enum CaptureMediaKind {
        PHOTO,
        VIDEO
    }

    /**
     * Derive capture ID from relative path (same semantics as gallery server).
     */
    public static String deriveCaptureId(String name) {
        if (name == null) {
            return "unknown";
        }

        if (name.contains("/")) {
            return name.substring(0, name.indexOf('/'));
        }

        String stem = name;

        if (stem.toLowerCase(Locale.US).endsWith(".imu.json")) {
            stem = stem.substring(0, stem.length() - ".imu.json".length());
            return stem;
        }

        int dotIdx = stem.lastIndexOf('.');
        if (dotIdx > 0) {
            stem = stem.substring(0, dotIdx);
        }

        stem = stem.replaceAll("_ev-?\\d+$", "");
        return stem;
    }

    public static boolean isAuxiliaryFile(String fileName) {
        if (fileName == null) {
            return false;
        }
        String lower = fileName.toLowerCase(Locale.US);
        String leaf = lower.contains("/") ? lower.substring(lower.lastIndexOf('/') + 1) : lower;

        if (leaf.equals("imu.json")) {
            return true;
        }
        return leaf.matches("ev-?\\d+\\.jpe?g$");
    }

    public static boolean isImuSidecar(String filename) {
        if (filename == null) {
            return false;
        }
        String leaf = filename.contains("/") ? filename.substring(filename.lastIndexOf('/') + 1) : filename;
        return leaf.equalsIgnoreCase("imu.json");
    }

    public static boolean isHdrBracket(String filename) {
        if (filename == null) {
            return false;
        }
        String leaf = filename.contains("/") ? filename.substring(filename.lastIndexOf('/') + 1) : filename;
        return leaf.toLowerCase(Locale.US).matches("ev-?\\d+\\.jpe?g");
    }

    /**
     * True if relative path ends with /base.jpg, /base.jpeg, or /base.mp4 (case-insensitive).
     */
    public static boolean isPrimaryBaseFile(String relativePath) {
        if (relativePath == null || !relativePath.contains("/")) {
            return false;
        }
        String leaf = relativePath.substring(relativePath.lastIndexOf('/') + 1).toLowerCase(Locale.US);
        return leaf.equals("base.jpg") || leaf.equals("base.jpeg") || leaf.equals("base.mp4");
    }

    public static Map<String, List<FileMetadata>> groupByCaptureId(List<FileMetadata> allFiles) {
        Map<String, List<FileMetadata>> map = new HashMap<>();
        for (FileMetadata m : allFiles) {
            String id = deriveCaptureId(m.getFileName());
            map.computeIfAbsent(id, k -> new ArrayList<>()).add(m);
        }
        return map;
    }

    public static boolean isValidCapture(List<FileMetadata> filesInCapture) {
        if (filesInCapture == null || filesInCapture.isEmpty()) {
            return false;
        }
        for (FileMetadata m : filesInCapture) {
            if (isPrimaryBaseFile(m.getFileName())) {
                return true;
            }
        }
        return false;
    }

    /**
     * If valid: VIDEO when any base.mp4 exists; else PHOTO when base.jpg/jpeg exists.
     */
    public static CaptureMediaKind classifyValidCaptureKind(List<FileMetadata> filesInCapture) {
        boolean hasMp4 = false;
        boolean hasJpg = false;
        for (FileMetadata m : filesInCapture) {
            String p = m.getFileName();
            if (!isPrimaryBaseFile(p)) {
                continue;
            }
            String leaf = p.substring(p.lastIndexOf('/') + 1).toLowerCase(Locale.US);
            if (leaf.equals("base.mp4")) {
                hasMp4 = true;
            } else if (leaf.equals("base.jpg") || leaf.equals("base.jpeg")) {
                hasJpg = true;
            }
        }
        if (hasMp4) {
            return CaptureMediaKind.VIDEO;
        }
        if (hasJpg) {
            return CaptureMediaKind.PHOTO;
        }
        return CaptureMediaKind.PHOTO;
    }

    public static long maxLastModified(List<FileMetadata> files) {
        long max = 0L;
        for (FileMetadata m : files) {
            if (m.getLastModified() > max) {
                max = m.getLastModified();
            }
        }
        return max;
    }

    /**
     * Capture uses a subdirectory (folder-based layout).
     */
    public static boolean isDirectoryStyleCapture(List<FileMetadata> filesInCapture) {
        for (FileMetadata m : filesInCapture) {
            if (m.getFileName().contains("/")) {
                return true;
            }
        }
        return false;
    }

    public static boolean isOrphanAutoDeleteCaptureId(String captureId) {
        if (captureId == null || captureId.isEmpty() || "unknown".equals(captureId)) {
            return false;
        }
        return captureId.startsWith("IMG_") || captureId.startsWith("VID_") || captureId.startsWith("BUFFER_");
    }

    /**
     * Capture IDs that have at least one base.* primary.
     */
    public static Set<String> validCaptureIds(List<FileMetadata> allFiles) {
        Map<String, List<FileMetadata>> groups = groupByCaptureId(allFiles);
        Set<String> valid = new HashSet<>();
        for (Map.Entry<String, List<FileMetadata>> e : groups.entrySet()) {
            if (isValidCapture(e.getValue())) {
                valid.add(e.getKey());
            }
        }
        return valid;
    }

    public static boolean isFileInValidCapture(String fileName, Set<String> validCaptureIds) {
        return validCaptureIds.contains(deriveCaptureId(fileName));
    }

    /**
     * Role within a capture for sync grouping: primary, bracket, or sidecar.
     */
    public static String assignFileRole(String fileName) {
        if (fileName == null) {
            return "primary";
        }
        String leaf = fileName.contains("/") ? fileName.substring(fileName.lastIndexOf('/') + 1) : fileName;
        String lower = leaf.toLowerCase(Locale.US);
        if (lower.equals("imu.json")) {
            return "sidecar";
        }
        if (lower.matches("ev-?\\d+\\.jpe?g")) {
            return "bracket";
        }
        return "primary";
    }
}
