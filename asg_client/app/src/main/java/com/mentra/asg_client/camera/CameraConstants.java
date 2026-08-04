package com.mentra.asg_client.camera;

/**
 * Camera resolution and quality constants for photo capture.
 *
 * There are two sets of resolutions:
 * - BUTTON: High quality for user's personal photos (stored locally, synced via gallery)
 * - SDK: Optimized for fast WiFi transfer (app-requested photos via take_photo command)
 *
 * Size tiers (canonical names):
 * - low: Ultra-fast transfers, suitable for thumbnails or quick previews
 * - medium: Good balance of quality and speed (SDK default)
 * - high: High quality for detailed analysis
 * - max: Highest JPEG size reported by camera hardware (~4032×3024)
 * - text: Internal text-mode sensor target from {@code AsgConstants} (not a public wire tier)
 */
public final class CameraConstants {

    private CameraConstants() {
        // Prevent instantiation
    }

    // =========================================================================
    // BUTTON PHOTO RESOLUTIONS
    // High quality - stored locally, transferred later via gallery sync
    // =========================================================================

    /** Button photo small resolution width (4:3 aspect ratio) */
    public static final int BUTTON_WIDTH_SMALL = 960;
    /** Button photo small resolution height */
    public static final int BUTTON_HEIGHT_SMALL = 720;

    /** Button photo medium resolution width (4:3 aspect ratio) */
    public static final int BUTTON_WIDTH_MEDIUM = 1440;
    /** Button photo medium resolution height */
    public static final int BUTTON_HEIGHT_MEDIUM = 1088;

    /** Button photo large resolution width - native sensor (4:3 aspect ratio) */
    public static final int BUTTON_WIDTH_LARGE = 3264;
    /** Button photo large resolution height - native sensor */
    public static final int BUTTON_HEIGHT_LARGE = 2448;

    /** JPEG quality for all button photos (high quality for personal photos) */
    public static final int BUTTON_JPEG_QUALITY = 95;

    // =========================================================================
    // SDK PHOTO RESOLUTIONS
    // Optimized for fast WiFi transfer to apps
    // =========================================================================

    /** SDK photo small resolution width (4:3 aspect ratio) - VGA */
    public static final int SDK_WIDTH_SMALL = 640;
    /** SDK photo small resolution height */
    public static final int SDK_HEIGHT_SMALL = 480;

    /** SDK photo medium resolution width (4:3 aspect ratio) - matches native sensor */
    public static final int SDK_WIDTH_MEDIUM = 1280;
    /** SDK photo medium resolution height */
    public static final int SDK_HEIGHT_MEDIUM = 960;

    /** SDK photo large resolution width (4:3 aspect ratio) - matches native sensor */
    public static final int SDK_WIDTH_LARGE = 1920;
    /** SDK photo large resolution height */
    public static final int SDK_HEIGHT_LARGE = 1440;

    // =========================================================================
    // SDK JPEG QUALITY SETTINGS
    // Lower quality = smaller files = faster transfer
    // =========================================================================

    /** JPEG quality for SDK small photos (prioritize speed) */
    public static final int SDK_JPEG_QUALITY_SMALL = 70;

    /** JPEG quality for SDK medium photos (good balance) */
    public static final int SDK_JPEG_QUALITY_MEDIUM = 80;

    /** JPEG quality for SDK large photos (prioritize quality) */
    public static final int SDK_JPEG_QUALITY_LARGE = 85;

    /** JPEG quality for SDK max / scan photos */
    public static final int SDK_JPEG_QUALITY_MAX = 95;

    // =========================================================================
    // SIZE TIER NAMES
    // =========================================================================

    public static final String SIZE_LOW = "low";
    public static final String SIZE_MEDIUM = "medium";
    public static final String SIZE_HIGH = "high";
    public static final String SIZE_MAX = "max";

    /**
     * Internal capture tier for text mode. Not accepted on the public {@code size} wire field —
     * produced by {@link com.mentra.asg_client.camera.policy.PhotoMode#captureSize} when {@code
     * mode=text}, and resolved via {@code AsgConstants.TEXT_MODE_SENSOR_CAPTURE_*}.
     */
    public static final String SIZE_TEXT = "text";

    // =========================================================================
    // EXPECTED FILE SIZES (approximate, for documentation)
    // =========================================================================
    // SDK small:  ~30-50 KB
    // SDK medium: ~80-150 KB
    // SDK large:  ~200-400 KB
    // SDK max:    ~2-4 MB
    // Button:     ~500 KB - 2 MB (depending on size setting)
}
