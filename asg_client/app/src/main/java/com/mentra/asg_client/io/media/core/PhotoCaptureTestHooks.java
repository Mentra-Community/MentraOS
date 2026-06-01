package com.mentra.asg_client.io.media.core;

/**
 * Production no-op hooks for optional photo-capture failure injection. The full test framework
 * lives under {@code src/test} — see {@link PhotoCaptureTestFramework}.
 */
public final class PhotoCaptureTestHooks {

    private PhotoCaptureTestHooks() {}

    public static boolean shouldFail(String step) {
        return false;
    }

    public static String getErrorCode() {
        return "";
    }

    public static String getErrorMessage() {
        return "";
    }

    public static void addFakeDelay(String step) {}

    public static void logTestConfig() {}
}
