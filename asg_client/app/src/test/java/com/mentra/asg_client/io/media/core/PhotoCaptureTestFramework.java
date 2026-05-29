package com.mentra.asg_client.io.media.core;

import android.util.Log;
import java.util.Random;

/**
 * PHOTO CAPTURE TESTING FRAMEWORK
 *
 * <p>Master controls for testing error scenarios in real-time Set these variables to test different
 * failure points
 */
public class PhotoCaptureTestFramework {
    // ===== MASTER CONTROLS =====
    public static final boolean ENABLE_FAKE_FAILURES = false; // Master switch
    public static final boolean ENABLE_FAKE_DELAYS = false; // Add artificial delays

    // ===== FAILURE TYPES =====
    public static final String FAILURE_TYPE_CAMERA_INIT = "CAMERA_INIT_FAILED";
    public static final String FAILURE_TYPE_CAMERA_CAPTURE = "CAMERA_CAPTURE_FAILED";
    public static final String FAILURE_TYPE_BLE_TRANSFER = "BLE_TRANSFER_FAILED";
    public static final String FAILURE_TYPE_UPLOAD = "UPLOAD_FAILED";
    public static final String FAILURE_TYPE_COMPRESSION = "COMPRESSION_FAILED";
    public static final String FAILURE_TYPE_RANDOM = "RANDOM_FAILURE";

    // ===== CURRENT TEST CONFIGURATION =====
    public static String FAILURE_TYPE = FAILURE_TYPE_CAMERA_CAPTURE; // Which failure to simulate
    public static final double FAILURE_PROBABILITY = 1.0; // 0.0 to 1.0 (100% when enabled)
    public static final int FAKE_DELAY_MS = 5000; // Artificial delay in milliseconds

    // ===== STEP-SPECIFIC CONTROLS =====
    public static final boolean FAIL_CAMERA_INIT = false; // Camera initialization
    public static final boolean FAIL_CAMERA_CAPTURE = false; // Photo capture
    public static final boolean FAIL_IMAGE_COMPRESSION = false; // Image compression
    public static final boolean FAIL_BLE_TRANSFER = false; // BLE file transfer
    public static final boolean FAIL_CLOUD_UPLOAD = false; // Cloud upload
    public static final boolean FAIL_RANDOM_STEP = false; // Random failure

    private static final Random random = new Random();

    /** Check if we should simulate a failure at this step */
    public static boolean shouldFail(String step) {
        if (!ENABLE_FAKE_FAILURES) return false;

        // Check step-specific controls first
        switch (step) {
            case "CAMERA_INIT":
                return FAIL_CAMERA_INIT || FAILURE_TYPE.equals(FAILURE_TYPE_CAMERA_INIT);
            case "CAMERA_CAPTURE":
                return FAIL_CAMERA_CAPTURE || FAILURE_TYPE.equals(FAILURE_TYPE_CAMERA_CAPTURE);
            case "COMPRESSION":
                return FAIL_IMAGE_COMPRESSION || FAILURE_TYPE.equals(FAILURE_TYPE_COMPRESSION);
            case "BLE_TRANSFER":
                return FAIL_BLE_TRANSFER || FAILURE_TYPE.equals(FAILURE_TYPE_BLE_TRANSFER);
            case "UPLOAD":
                return FAIL_CLOUD_UPLOAD || FAILURE_TYPE.equals(FAILURE_TYPE_UPLOAD);
            case "RANDOM":
                return FAIL_RANDOM_STEP || FAILURE_TYPE.equals(FAILURE_TYPE_RANDOM);
            default:
                return false;
        }
    }

    /** Get the error code for the current failure type based on which flag is enabled */
    public static String getErrorCode() {
        if (FAIL_CAMERA_INIT) return FAILURE_TYPE_CAMERA_INIT;
        if (FAIL_CAMERA_CAPTURE) return FAILURE_TYPE_CAMERA_CAPTURE;
        if (FAIL_IMAGE_COMPRESSION) return FAILURE_TYPE_COMPRESSION;
        if (FAIL_BLE_TRANSFER) return FAILURE_TYPE_BLE_TRANSFER;
        if (FAIL_CLOUD_UPLOAD) return FAILURE_TYPE_UPLOAD;
        if (FAIL_RANDOM_STEP) return FAILURE_TYPE_RANDOM;
        return FAILURE_TYPE; // Fallback to manual setting
    }

    /** Get a descriptive error message based on which flag is enabled */
    public static String getErrorMessage() {
        if (FAIL_CAMERA_INIT) return "TESTING: Fake camera initialization failure";
        if (FAIL_CAMERA_CAPTURE) return "TESTING: Fake photo capture failure";
        if (FAIL_IMAGE_COMPRESSION) return "TESTING: Fake compression failure";
        if (FAIL_BLE_TRANSFER) return "TESTING: Fake BLE transfer failure";
        if (FAIL_CLOUD_UPLOAD) return "TESTING: Fake upload failure";
        if (FAIL_RANDOM_STEP) return "TESTING: Random fake failure";

        // Fallback to manual setting
        switch (FAILURE_TYPE) {
            case FAILURE_TYPE_CAMERA_INIT:
                return "TESTING: Fake camera initialization failure";
            case FAILURE_TYPE_CAMERA_CAPTURE:
                return "TESTING: Fake photo capture failure";
            case FAILURE_TYPE_BLE_TRANSFER:
                return "TESTING: Fake BLE transfer failure";
            case FAILURE_TYPE_UPLOAD:
                return "TESTING: Fake upload failure";
            case FAILURE_TYPE_COMPRESSION:
                return "TESTING: Fake compression failure";
            case FAILURE_TYPE_RANDOM:
                return "TESTING: Random fake failure";
            default:
                return "TESTING: Unknown fake failure";
        }
    }

    /** Add artificial delay for testing timeout scenarios */
    public static void addFakeDelay(String step) {
        if (ENABLE_FAKE_DELAYS) {
            Log.d("PhotoTest", "Adding " + FAKE_DELAY_MS + "ms delay at step: " + step);
            try {
                Thread.sleep(FAKE_DELAY_MS);
            } catch (InterruptedException e) {
                Log.e("PhotoTest", "Delay interrupted", e);
            }
        }
    }

    /** Log current test configuration */
    public static void logTestConfig() {
        Log.d("PhotoTest", "=== PHOTO CAPTURE TEST CONFIG ===");
        Log.d("PhotoTest", "ENABLE_FAKE_FAILURES: " + ENABLE_FAKE_FAILURES);
        Log.d("PhotoTest", "ENABLE_FAKE_DELAYS: " + ENABLE_FAKE_DELAYS);
        Log.d("PhotoTest", "FAILURE_TYPE: " + FAILURE_TYPE);
        Log.d("PhotoTest", "FAIL_CAMERA_INIT: " + FAIL_CAMERA_INIT);
        Log.d("PhotoTest", "FAIL_CAMERA_CAPTURE: " + FAIL_CAMERA_CAPTURE);
        Log.d("PhotoTest", "FAIL_IMAGE_COMPRESSION: " + FAIL_IMAGE_COMPRESSION);
        Log.d("PhotoTest", "FAIL_BLE_TRANSFER: " + FAIL_BLE_TRANSFER);
        Log.d("PhotoTest", "FAIL_CLOUD_UPLOAD: " + FAIL_CLOUD_UPLOAD);
        Log.d("PhotoTest", "FAIL_RANDOM_STEP: " + FAIL_RANDOM_STEP);
        Log.d("PhotoTest", "================================");
    }
}
