package com.mentra.asg_client;

public class AsgConstants {
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
    public static final boolean FORCE_BLE_TRANSFER = true;

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
     * Dump text-detect intermediates to {@code textdetect_debug/} on every detection run. Adds
     * per-photo I/O overhead; keep false in production.
     */
    public static final boolean SAVE_TEXT_DETECT_DEBUG_ARTIFACTS = false;

    /** After AE meters in text mode, divide exposure time by this factor (shorter shutter). */
    public static final int TEXT_MODE_AE_EXPOSURE_DIVISOR = 3;

    /** Long-edge cap for text-mode BLE downscale after crop (aspect ratio preserved). */
    public static final int TEXT_MODE_BLE_TARGET_WIDTH = 1920;

    public static final int TEXT_MODE_BLE_TARGET_HEIGHT = 1920;

    /** AVIF constant-quality for text-mode BLE encode and max size-tier BLE encode. */
    public static final int TEXT_MODE_AVIF_QUALITY = 55;

    /** JPEG quality when skipping AVIF for small BLE payloads. */
    public static final int TEXT_MODE_BLE_JPEG_QUALITY = 95;

    /** Skip AVIF and send JPEG when the source capture is already under this size. */
    public static final int TEXT_MODE_AVIF_SIZE_THRESHOLD_BYTES = 200 * 1024;

    // BLE size-tier downscale caps (long edge; aspect ratio preserved) and AVIF quality
    public static final int BLE_PHOTO_LOW_TARGET_PX = 800;
    public static final int BLE_PHOTO_LOW_AVIF_QUALITY = 50;
    public static final int BLE_PHOTO_MEDIUM_TARGET_PX = 1280;
    public static final int BLE_PHOTO_MEDIUM_AVIF_QUALITY = 50;
    public static final int BLE_PHOTO_HIGH_TARGET_PX = 1600;
    public static final int BLE_PHOTO_HIGH_AVIF_QUALITY = 48;
    public static final int BLE_PHOTO_MAX_TARGET_PX = 1920;

    // Text-region detector production flags (see MediaCaptureService.buildTextDetectConfig)
    public static final boolean TEXT_DETECT_ALLOW_SINGLE_COMPONENT_LINES = true;
    public static final boolean TEXT_DETECT_CROP_FROM_TOP_LINE_ONLY = true;
    public static final boolean TEXT_DETECT_ENABLE_STRUCTURE_FILTER = true;
}
