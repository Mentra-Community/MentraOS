package com.mentra.asg_client.io.media.core.textdetect;

import android.util.Log;
import org.opencv.android.OpenCVLoader;

/**
 * One-time OpenCV native-library initialization. On Android uses {@link OpenCVLoader}; on a plain
 * JVM (offline harness) loads the desktop build via reflection so main sources do not depend on the
 * test-only OpenPnP artifact.
 */
public final class CvInit {
    private static final String TAG = "CvInit";

    private static volatile boolean loaded;

    private CvInit() {}

    /**
     * Loads the OpenCV native library exactly once; safe to call repeatedly and from any thread.
     * Tries the desktop JVM build first (offline harness), then the Android loader. Throws
     * {@link IllegalStateException} if neither succeeds.
     */
    public static void ensureLoaded() {
        if (loaded) {
            return;
        }
        synchronized (CvInit.class) {
            if (loaded) {
                return;
            }
            if (tryLoadDesktopOpenCv()) {
                loaded = true;
                logDebug("OpenCV loaded (desktop JVM)");
                return;
            }
            if (OpenCVLoader.initLocal()) {
                loaded = true;
                logDebug("OpenCV loaded (Android)");
                return;
            }
            throw new IllegalStateException("Failed to initialize OpenCV native library");
        }
    }

    /** Visible for tests that pre-load OpenCV through OpenPnP before calling detector code. */
    static void markLoadedForTesting() {
        loaded = true;
    }

    private static boolean tryLoadDesktopOpenCv() {
        try {
            Class<?> openCvClass = Class.forName("nu.pattern.OpenCV");
            openCvClass.getMethod("loadShared").invoke(null);
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        } catch (ReflectiveOperationException e) {
            logWarn("Desktop OpenCV load failed: " + e.getMessage());
            return false;
        }
    }

    private static void logDebug(String message) {
        try {
            Log.d(TAG, message);
        } catch (RuntimeException ignored) {
            // android.util.Log is not mocked in plain JVM unit tests.
        }
    }

    private static void logWarn(String message) {
        try {
            Log.w(TAG, message);
        } catch (RuntimeException ignored) {
            // android.util.Log is not mocked in plain JVM unit tests.
        }
    }
}
