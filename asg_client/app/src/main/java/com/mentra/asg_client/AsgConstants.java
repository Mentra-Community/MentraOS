package com.mentra.asg_client;

import com.mentra.asg_client.io.media.core.textdetect.roi.TextCropModel;

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

    /** Use the selected ONNX text detector instead of the classical OpenCV detector. */
    public static final boolean ENABLE_MODEL_TEXT_CROP = false;

    /** Text-region detector selected when {@link #ENABLE_MODEL_TEXT_CROP} is enabled. */
    public static final TextCropModel TEXT_CROP_MODEL = TextCropModel.PPOCR_V5_MOBILE_DET;

    /**
     * Dump text-detect intermediates to {@code textdetect_debug/} on every detection run. Adds
     * per-photo I/O overhead; keep false in production.
     */
    public static final boolean SAVE_TEXT_DETECT_DEBUG_ARTIFACTS = false;

    /**
     * Emit {@code ⏱️ [BLE PHOTO]} timing logs for the full take_photo → AVIF/JPEG compress → BLE
     * transfer pipeline. Filter logcat on tag {@code BlePhotoTiming} or prefix {@code ⏱️ [BLE
     * PHOTO]}. Keep false in production.
     */
    public static final boolean ENABLE_PHOTO_TIMING_LOGS = true;

    /** After AE meters in text mode, divide exposure time by this factor (shorter shutter). */
    public static final int TEXT_MODE_AE_EXPOSURE_DIVISOR = 3;

    /** Long-edge cap for text-mode BLE downscale after crop (aspect ratio preserved). */
    public static final int TEXT_MODE_BLE_TARGET_WIDTH = 1920;

    public static final int TEXT_MODE_BLE_TARGET_HEIGHT = 1920;

    /** AVIF quality for the canonical text-mode BLE payload. */
    public static final int TEXT_MODE_AVIF_QUALITY = 55;

    /** JPEG quality for the canonical text-mode crop written to disk (gallery/WiFi upload). */
    public static final int TEXT_MODE_BLE_JPEG_QUALITY = 95;

    /**
     * Codec for every BLE photo payload — text mode and ordinary size-tier photos alike. Change
     * this one value to {@code AVIF} or {@code JPEG_FAST} to switch both paths at once.
     */
    public static final String BLE_PHOTO_CODEC = "JPEG_FAST";

    /**
     * JPEG quality for all BLE photo payloads when {@link #BLE_PHOTO_CODEC} is {@code JPEG_FAST}.
     */
    public static final int BLE_PHOTO_JPEG_FAST_QUALITY = 80;

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
    public static final boolean TEXT_DETECT_IMPROVED_CROP_ACCURACY = true;
    public static final float TEXT_DETECT_MIN_CROP_AREA_FRACTION = 0.004f;
}
