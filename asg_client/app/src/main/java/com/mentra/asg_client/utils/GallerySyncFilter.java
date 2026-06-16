package com.mentra.asg_client.utils;

import java.util.Collections;
import java.util.Set;

/**
 * Shared rules for which gallery files may be counted, listed, or synced to the phone.
 */
public final class GallerySyncFilter {

    private GallerySyncFilter() {}

    /**
     * Derive capture directory ID from a relative file path.
     */
    public static String deriveCaptureId(String name) {
        if (name == null) {
            return "unknown";
        }
        if (name.contains("/")) {
            return name.substring(0, name.indexOf('/'));
        }
        String stem = name;
        if (stem.toLowerCase().endsWith(".imu.json")) {
            return stem.substring(0, stem.length() - ".imu.json".length());
        }
        int dotIdx = stem.lastIndexOf('.');
        if (dotIdx > 0) {
            stem = stem.substring(0, dotIdx);
        }
        stem = stem.replaceAll("_ev-?\\d+$", "");
        return stem;
    }

    /**
     * True when the file is a primary video container with no bytes yet (in-progress or corrupt).
     */
    public static boolean isZeroBytePrimaryVideo(String fileName, long fileSize) {
        if (fileSize > 0 || fileName == null) {
            return false;
        }
        String leaf = fileName.contains("/") ? fileName.substring(fileName.lastIndexOf('/') + 1) : fileName;
        String lower = leaf.toLowerCase();
        if (lower.equals("base.mp4")) {
            return true;
        }
        return lower.endsWith(".mp4")
                || lower.endsWith(".mov")
                || lower.endsWith(".avi")
                || lower.endsWith(".mkv")
                || lower.endsWith(".webm")
                || lower.endsWith(".3gp");
    }

    /**
     * True when the capture is actively recording or awaiting post-stop integrity validation.
     */
    public static boolean isCaptureBlockedFromSync(
            String fileName, String activeCaptureId, Set<String> blockedCaptureIds) {
        String captureId = deriveCaptureId(fileName);
        if (activeCaptureId != null && activeCaptureId.equals(captureId)) {
            return true;
        }
        Set<String> blocked = blockedCaptureIds != null ? blockedCaptureIds : Collections.emptySet();
        return blocked.contains(captureId);
    }
}
