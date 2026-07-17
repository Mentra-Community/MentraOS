package com.mentra.asg_client;

public class AsgConstants {
    /** Mentra Live hotspot idle timeout after the last local HTTP activity. */
    public static final long HOTSPOT_INACTIVITY_TIMEOUT_MS = 120_000L;

    /** Frequency for checking whether an active hotspot has become idle. */
    public static final long HOTSPOT_INACTIVITY_CHECK_INTERVAL_MS = 10_000L;

    /** Maximum interval between activity updates while a response body is streaming. */
    public static final long HTTP_ACTIVITY_STREAM_UPDATE_INTERVAL_MS = 5_000L;

    /** How often Mentra Live checks for the LocalOnlyHotspot gateway interface. */
    public static final long LOCAL_HOTSPOT_READINESS_POLL_MS = 200L;

    /** Maximum wait for the LocalOnlyHotspot gateway interface to become ready. */
    public static final long LOCAL_HOTSPOT_READINESS_TIMEOUT_MS = 12_000L;

    /** Current Mentra Live Android hotspot gateway when interface discovery is unavailable. */
    public static final String DEFAULT_HOTSPOT_GATEWAY_IP = "192.168.43.1";

    public static String appName = "AugmentOS ASG Client";
    public static int augmentOsSdkVerion = 1;
    public static int asgServiceNotificationId = 3540;
    public static int asgPackageMonitorServiceNotificationId = 3541;
    public static String glassesCardTitle = "";
    public static String displayRequestsKey = "display_requests";
    public static String proactiveAgentResultsKey = "results_proactive_agent_insights";
    public static String explicitAgentQueriesKey = "explicit_insight_queries";
    public static String explicitAgentResultsKey = "explicit_insight_results";
    public static String wakeWordTimeKey = "wake_word_time";
    public static String entityDefinitionsKey = "entity_definitions";
    public static String languageLearningKey = "language_learning_results";
    public static String llContextConvoKey = "ll_context_convo_results";
    public static String llWordSuggestUpgradeKey = "ll_word_suggest_upgrade_results";
    public static String shouldUpdateSettingsKey = "should_update_settings";
    public static String adhdStmbAgentKey = "adhd_stmb_agent_results";
    public static String notificationFilterKey = "notification_results";
    public static String newsSummaryKey = "news_summary_results";

    // endpoints
    public static final String LLM_QUERY_ENDPOINT = "/chat";
    public static final String SEND_NOTIFICATIONS_ENDPOINT = "/send_notifications";
    public static final String DIARIZE_QUERY_ENDPOINT = "/chat_diarization";
    public static final String GEOLOCATION_STREAM_ENDPOINT = "/gps_location";
    public static final String BUTTON_EVENT_ENDPOINT = "/button_event";
    public static final String UI_POLL_ENDPOINT = "/ui_poll";
    public static final String SET_USER_SETTINGS_ENDPOINT = "/set_user_settings";
    public static final String GET_USER_SETTINGS_ENDPOINT = "/get_user_settings";
    public static final String REQUEST_APP_BY_PACKAGE_NAME_DOWNLOAD_LINK_ENDPOINT =
            "/request_app_by_package_name_download_link";

    // Battery status broadcast action
    public static final String ACTION_GLASSES_BATTERY_STATUS =
            "com.mentra.recovery.ACTION_GLASSES_BATTERY_STATUS";

    /**
     * Awake window granted per wake-flagged phone command ("W":1 string wrapper or FLAG_WAKE
     * binary frame). The BES only pulses the MTK power key for these when the SoC is already
     * asleep, so a command landing mid-awake-window gets no extra time — this window is the
     * in-band equivalent. Must outlive the longest command follow-up that runs on
     * suspend-frozen clocks: the wifi credentials flow sends its failure verdict at ~12.4s
     * (3s + 3x3s status polls), so 15s covers it with margin. Acquired extend-only, so it
     * never shortens a longer-lived lock (BES/MTK OTA).
     */
    public static final long PHONE_WAKE_COMMAND_WINDOW_MS = 15000;

    /**
     * Rolling wake-lease window re-armed on confirmed BES OTA segments. The BES UART
     * transfer dies when the vendor display-sleep hook fires mid-flight even with a CPU
     * lock held (2026-07-08 incident: frozen between segments at 80% with 4:40 left on
     * the lock), so the transfer holds BOTH cpu and screen leases and re-arms them while
     * segments keep confirming: progress keeps the device awake, a wedged transfer lets
     * it sleep within this window (aligned with the phone's 120s stall watchdog).
     */
    public static final long BES_OTA_SEGMENT_LEASE_WINDOW_MS = 120000;

    /**
     * Dead-man window for the BES OTA transfer. The transfer is response-driven (every BES
     * response triggers the next send, there is no wait loop), so one lost response stalls
     * it silently forever. If no OTA response arrives within this window the transfer is
     * aborted through the normal failure path - the BES stays on its current firmware and
     * the phone retries the whole OTA. Kept well below the phone's 120s stall watchdog so
     * the glasses clean up first; normal inter-response gaps are under a second.
     */
    public static final long BES_OTA_RESPONSE_TIMEOUT_MS = 30000;

    // RGB LED Control Constants (Glasses BES Chipset - Remote Control via Bluetooth)
    // NOTE: These are different from the local MTK recording LED

    // K900 Protocol Commands for RGB LEDs
    public static final String K900_CMD_RGB_LED_ON = "cs_ledon";
    public static final String K900_CMD_RGB_LED_OFF = "cs_ledoff";
    public static final String K900_CMD_ANDROID_CONTROL_LED =
            "android_control_led"; // Authority handoff

    // RGB LED Color Indices (BES Chipset on Glasses)
    public static final int RGB_LED_RED = 0;
    public static final int RGB_LED_GREEN = 1;
    public static final int RGB_LED_BLUE = 2;

    // RGB LED Command Types (from phone to glasses)
    public static final String CMD_RGB_LED_CONTROL_ON = "rgb_led_control_on";
    public static final String CMD_RGB_LED_CONTROL_OFF = "rgb_led_control_off";

    // Photo capture: BLE transfer and text mode
    // -------------------------------------------------------------------------

    /**
     * When true and {@code bleImgId} is present, every {@code take_photo} uses BLE transfer
     * regardless of requested {@code transferMethod}. Dev stopgap — set false for production.
     */
    public static final boolean FORCE_BLE_TRANSFER = false;

    /**
     * Grayscale luma BLE pipeline (crop + contrast + unsharp on 1-byte/pixel buffers). When false,
     * uses the legacy full-color decode → scale → sharpen path.
     */
    public static final boolean ENABLE_GRAYSCALE_BLE_PHOTOS = false;

    /**
     * Run text-region detection and crop on all BLE photos. When false, crop runs only when {@code
     * mode == "text"}.
     */
    public static final boolean ENABLE_TEXT_REGION_CROP = false;

    /**
     * Emit {@code ⏱️ [BLE PHOTO]} timing logs for the full take_photo → AVIF/JPEG compress → BLE
     * transfer pipeline. Filter logcat on tag {@code BlePhotoTiming} or prefix {@code ⏱️ [BLE
     * PHOTO]}. Keep false in production.
     */
    public static final boolean ENABLE_PHOTO_TIMING_LOGS = true;

    /** After AE meters in text mode, divide exposure time by this factor (shorter shutter). */
    public static final int TEXT_MODE_AE_EXPOSURE_DIVISOR = 3;

    /**
     * Requested sensor JPEG width for text-mode capture (and matching warm-up). Mentra Live's
     * maximum supported 16:9 still size is 3840×2160 (4K UHD); the full sensor max is 4032×3024
     * (4:3). Camera2 selects an exact match when available, otherwise the closest supported size.
     */
    public static final int TEXT_MODE_SENSOR_CAPTURE_WIDTH = 3840;

    /**
     * Requested sensor JPEG height for text-mode capture (and matching warm-up). Paired with {@link
     * #TEXT_MODE_SENSOR_CAPTURE_WIDTH} for Mentra Live's max 16:9 still size.
     */
    public static final int TEXT_MODE_SENSOR_CAPTURE_HEIGHT = 2160;

    /** Long-edge cap for text-mode BLE downscale after crop (aspect ratio preserved). */
    public static final int TEXT_MODE_BLE_TARGET_WIDTH = 1920;

    public static final int TEXT_MODE_BLE_TARGET_HEIGHT = 1920;

    /** AVIF quality for the canonical text-mode BLE payload. */
    public static final int TEXT_MODE_AVIF_QUALITY = 55;

    /** JPEG quality for the canonical text-mode crop written to disk (gallery/WiFi upload). */
    public static final int TEXT_MODE_BLE_JPEG_QUALITY = 80;

    /** Long-edge size used for on-glasses ML Kit text localization. */
    // 1280 is the smallest tested size that consistently retained stylized/low-contrast label
    // text on real 4032x3024 Mentra Live captures while remaining below the 1s detector budget.
    public static final int TEXT_MODE_MLKIT_ANALYSIS_LONG_EDGE = 1280;

    /** Minimum source-pixel padding around the union of ML Kit text lines. */
    public static final int TEXT_MODE_MLKIT_MIN_PADDING_PX = 32;

    /** Horizontal padding relative to the detected text-union width. */
    public static final float TEXT_MODE_MLKIT_PADDING_X_FRACTION = 0.12f;

    /** Vertical padding relative to the detected text-union height. */
    public static final float TEXT_MODE_MLKIT_PADDING_Y_FRACTION = 0.25f;

    // A lone OCR line is weak evidence for the complete text-bearing object. Keep generous
    // surrounding context so a small conventional label can pull in nearby stylized text that
    // the recognizer did not box (validated on curved product labels).
    public static final float TEXT_MODE_MLKIT_SINGLE_LINE_PADDING_X_HEIGHTS = 3f;
    public static final float TEXT_MODE_MLKIT_SINGLE_LINE_PADDING_TOP_HEIGHTS = 4f;
    public static final float TEXT_MODE_MLKIT_SINGLE_LINE_PADDING_BOTTOM_HEIGHTS = 11f;

    /** Hard timeout for one local ML Kit request; failure preserves the full frame. */
    public static final long TEXT_MODE_MLKIT_TIMEOUT_MS = 5000L;

    /**
     * Codec for every BLE photo payload — text mode and ordinary size-tier photos alike. Change
     * this one value to {@code AVIF} or {@code JPEG_FAST} to switch both paths at once.
     */
    public static final String BLE_PHOTO_CODEC = "JPEG_FAST";

    /**
     * JPEG quality for all BLE photo payloads when {@link #BLE_PHOTO_CODEC} is {@code JPEG_FAST}.
     */
    public static final int BLE_PHOTO_JPEG_FAST_QUALITY = 80;

    /**
     * Max wait for the deferred background photo write ({@code CapturedPhoto.persistence}) when a
     * BLE photo consumer needs the file on disk (gallery save, text-mode canonical crop, cleanup).
     * Generous: the write runs concurrently with capture-to-transfer work and normally finishes
     * long before anyone awaits it.
     */
    public static final long BLE_PHOTO_PERSISTENCE_AWAIT_TIMEOUT_MS = 10_000;

    // BLE size-tier downscale caps (long edge; aspect ratio preserved) and AVIF quality
    public static final int BLE_PHOTO_LOW_TARGET_PX = 800;
    public static final int BLE_PHOTO_LOW_AVIF_QUALITY = 50;
    public static final int BLE_PHOTO_MEDIUM_TARGET_PX = 1280;
    public static final int BLE_PHOTO_MEDIUM_AVIF_QUALITY = 50;
    public static final int BLE_PHOTO_HIGH_TARGET_PX = 1600;
    public static final int BLE_PHOTO_HIGH_AVIF_QUALITY = 48;
    public static final int BLE_PHOTO_MAX_TARGET_PX = 1920;
}
