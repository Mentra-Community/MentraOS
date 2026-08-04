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

    /** Delay after enabling the WiFi radio before requesting a LocalOnlyHotspot. */
    public static final long LOCAL_HOTSPOT_WIFI_ENABLE_DELAY_MS = 500L;

    /** Current Mentra Live Android hotspot gateway when interface discovery is unavailable. */
    public static final String DEFAULT_HOTSPOT_GATEWAY_IP = "192.168.43.1";

    /** Canonical camera crop defaults shared with the phone and Bluetooth SDK. */
    public static final int CAMERA_FOV_DEFAULT = 118;

    public static final int CAMERA_ROI_POSITION_DEFAULT = 0;

    /** Cadence for live stream bitrate, frame-rate, duration, and thermal telemetry. */
    public static final long STREAM_METRICS_INTERVAL_MS = 1_000L;

    /**
     * Local-testing stopgap that disables the 60s keep-alive watchdog for RTMP/SRT/WHIP streams.
     * When true, {@code scheduleStreamTimeout()} early-returns and an orphaned stream (lost
     * phone/cloud keep-alives via BLE disconnect or killed app) never auto-stops, holding the
     * camera and draining battery/thermals. MUST stay false for production; flip locally only.
     */
    public static final boolean DISABLE_STREAM_KEEP_ALIVE_TIMEOUT = false;

    /** Linux thermal sysfs root used to discover the Mentra Live CPU sensor. */
    public static final String THERMAL_SYSFS_ROOT = "/sys/class/thermal";

    /** MediaTek thermal-zone type that reports Mentra Live CPU temperature. */
    public static final String CPU_THERMAL_ZONE_TYPE = "mtktscpu";

    /** Known Mentra Live CPU-temperature fallback when sysfs type discovery is unavailable. */
    public static final String CPU_THERMAL_FALLBACK_PATH = "/sys/class/thermal/thermal_zone1/temp";

    /** Warm-up leases are intentionally short-lived to bound idle camera power use. */
    public static final long CAMERA_WARM_UP_DEFAULT_DURATION_MS = 15_000L;

    public static final long CAMERA_WARM_UP_MAX_DURATION_MS = 60_000L;

    /** Cadence for the short hold-still click while a cold photo spins up the camera. */
    public static final long CAMERA_PREP_CLICK_INTERVAL_MS = 900L;

    /** Target lead before the estimated end of sensor exposure for starting the camera snap. */
    public static final long CAMERA_SNAP_TARGET_LEAD_MS = 100L;

    /** Safety lease for a miniapp-owned transient FOV override. */
    public static final long CAMERA_FOV_OVERRIDE_DEFAULT_TTL_MS = 300_000L;

    public static final long CAMERA_FOV_OVERRIDE_MAX_TTL_MS = 600_000L;

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
     * Awake window granted per wake-flagged phone command ("W":1 string wrapper or FLAG_WAKE binary
     * frame). The BES only pulses the MTK power key for these when the SoC is already asleep, so a
     * command landing mid-awake-window gets no extra time — this window is the in-band equivalent.
     * Must outlive the longest command follow-up that runs on suspend-frozen clocks: the wifi
     * credentials flow sends its failure verdict at ~12.4s (3s + 3x3s status polls), so 15s covers
     * it with margin. Acquired extend-only, so it never shortens a longer-lived lock (BES/MTK OTA).
     */
    public static final long PHONE_WAKE_COMMAND_WINDOW_MS = 15000;

    /**
     * Rolling wake-lease window re-armed on confirmed BES OTA segments. The BES UART transfer dies
     * when the vendor display-sleep hook fires mid-flight even with a CPU lock held (2026-07-08
     * incident: frozen between segments at 80% with 4:40 left on the lock), so the transfer holds
     * BOTH cpu and screen leases and re-arms them while segments keep confirming: progress keeps
     * the device awake, a wedged transfer lets it sleep within this window (aligned with the
     * phone's 120s stall watchdog).
     */
    public static final long BES_OTA_SEGMENT_LEASE_WINDOW_MS = 120000;

    /**
     * Dead-man window for the BES OTA transfer. The transfer is response-driven (every BES response
     * triggers the next send, there is no wait loop), so one lost response stalls it silently
     * forever. If no OTA response arrives within this window the transfer is aborted through the
     * normal failure path - the BES stays on its current firmware and the phone retries the whole
     * OTA. Kept well below the phone's 120s stall watchdog so the glasses clean up first; normal
     * inter-response gaps are under a second.
     */
    public static final long BES_OTA_RESPONSE_TIMEOUT_MS = 30000;

    /**
     * Resend schedule for the post-APK-restart OTA completion push
     * (OtaHelper#sendCompletionToPhone). The freshly installed process races its own UART transport
     * startup, and a one-shot send can be silently lost — the phone then fails a successful update
     * via its 120s stall watchdog (incident rep_01KY31HEMTSBSMK8DVMNXJ5XGG). 15 attempts x 3s = 45s
     * of coverage, well past transport settle and below the phone's watchdog. Duplicate terminal
     * statuses are idempotent on the phone.
     */
    public static final long OTA_COMPLETION_RESEND_INTERVAL_MS = 3_000L;

    /**
     * Number of post-APK-restart completion resend attempts (see {@link
     * #OTA_COMPLETION_RESEND_INTERVAL_MS}).
     */
    public static final int OTA_COMPLETION_RESEND_ATTEMPTS = 15;

    /**
     * FALLBACK maximum packed frame size for a v1 K900 STRING ck chunk, used until the BES
     * advertises its true notification cap. The BES relays v1 string frames to the phone in a
     * single unfragmented BLE notification, and the worst-case ATT payload on that link is 253
     * bytes (ATT MTU 256) regardless of the MTU the phone requested — a packed chunk over that cap
     * is silently truncated on the wire and the phone drops it as unparseable (incident
     * rep_01KY6BJ0B7A4RBMQ7VN39KAE5E: OTA completion ck chunks packed to 256-263 bytes and none
     * survived). 240 = 253 - {@link #K900_STRING_CHUNK_BUDGET_MARGIN_BYTES}. BES firmware >=
     * 17.26.7.23 advertises {@code wire_caps.notify_cap} (the measured single-notification payload
     * cap) and the budget becomes notify_cap minus the same margin — see Legacy v1 string frames
     * never grow from negotiated notify capacity.
     */
    public static final int K900_STRING_CHUNK_MAX_FRAME_BYTES = 240;

    /** Exact BES release artifact container accepted by the ASG OTA validator. */
    public static final String BES_OTA_ARTIFACT_FORMAT = "bes-lzma-chunks-v1";

    /** Mentra Live BES build target required in release metadata and the image payload. */
    public static final String BES_OTA_PRODUCT = "best1502x_ibrt_bpone";

    /**
     * Exclusive decompressed destination limit in the deployed ota_copy bootloader:
     * NEW_IMAGE_FLASH_OFFSET (0x200000) - OTA_CODE_OFFSET (0x20000). Images at or above this size
     * overwrite the adjacent staging region and must never be sent to BES.
     */
    public static final int BES_OTA_MAX_DECOMPRESSED_IMAGE_BYTES = 0x1E0000;

    /**
     * Safety margin subtracted from the BLE notification payload cap when sizing packed v1 STRING
     * ck chunks, absorbing BES re-framing variance between the UART frame we send and the
     * notification the BES actually emits (240 = 253 - 13 was the hardware-validated budget for the
     * worst-case 253-byte cap).
     */
    public static final int K900_STRING_CHUNK_BUDGET_MARGIN_BYTES = 13;

    /**
     * Contract floor of {@code wire_caps.notify_cap} (BES firmware >= 17.26.7.23 computes max(253,
     * min(ATT MTU - 3, 509))). An advertised value below this is malformed and is ignored in favor
     * of the fallback budget.
     */
    public static final int K900_BLE_NOTIFY_CAP_FLOOR_BYTES = 253;

    /**
     * Contract ceiling of {@code wire_caps.notify_cap} (see {@link
     * #K900_BLE_NOTIFY_CAP_FLOOR_BYTES}: the BES computes max(253, min(ATT MTU - 3, 509))). An
     * advertised value above this is malformed; it is clamped down so a buggy advertisement can
     * never size chunks beyond what the transport carries — the exact silent truncation class the
     * notification budget exists to prevent.
     */
    public static final int K900_BLE_NOTIFY_CAP_CEILING_BYTES = 509;

    /** Rendezvous baud shared by every ASG and BES firmware generation. */
    public static final int UART_RENDEZVOUS_BAUD = 460800;

    /** Fast UART baud negotiated after the rendezvous link proves compatible firmware. */
    public static final int UART_FAST_BAUD = 1152000;

    /** First BES firmware version that implements the {@code cs_baud}/{@code sr_baud} contract. */
    public static final String UART_FAST_BAUD_MIN_BES_VERSION = "17.26.7.5";

    /** Delay after BES acknowledges {@code cs_baud} before ASG reopens at the fast rate. */
    public static final long UART_BAUD_REOPEN_DELAY_MS = 250;

    /** Time allowed for the version probe that proves the newly negotiated fast link. */
    public static final long UART_BAUD_PROBE_TIMEOUT_MS = 3000;

    /** Delay before probing the alternate UART baud after ASG starts at the rendezvous rate. */
    public static final long UART_BOOT_RECOVERY_INITIAL_DELAY_MS = 8000;

    /** Number of spaced system-version probes used to tolerate short BES UART restart windows. */
    public static final int UART_RECOVERY_PROBES_PER_BURST = 5;

    /** Spacing between UART recovery probes. */
    public static final long UART_RECOVERY_PROBE_SPACING_MS = 400;

    /** Parser-discarded bytes that indicate the two UART endpoints likely disagree on baud. */
    public static final long UART_RUNTIME_RECOVERY_DISCARDED_BYTES = 24;

    /** Corrupt UART reads that trigger a link probe even when each wrong-baud burst is tiny. */
    public static final int UART_RUNTIME_RECOVERY_DISCARD_EVENTS = 4;

    /** Idle time after a confirmed fast link before actively verifying that BES is still there. */
    public static final long UART_HIGH_BAUD_IDLE_PROBE_MS = 15000;

    /** Number of version probes sent at each baud during live-link recovery. */
    public static final int UART_RUNTIME_RECOVERY_PROBES_PER_BAUD = 3;

    /** Spacing between live-link recovery probes. */
    public static final long UART_RUNTIME_RECOVERY_PROBE_SPACING_MS = 150;

    /** Time allowed for a live-link recovery baud candidate to answer. */
    public static final long UART_RUNTIME_RECOVERY_STEP_TIMEOUT_MS = 700;

    /** Initial delay before retrying a live-link recovery scan that found neither endpoint. */
    public static final long UART_RUNTIME_RECOVERY_RETRY_DELAY_MS = 3000;

    /** Maximum delay between failed live-link recovery scans while parked at rendezvous baud. */
    public static final long UART_RUNTIME_RECOVERY_MAX_RETRY_DELAY_MS = 60000;

    /** Maximum wait for the old-baud {@code sr_baud} acknowledgement before probing target baud. */
    public static final long UART_BAUD_ACK_TIMEOUT_MS = 1000;

    /** Time allowed for BES to reboot at the rendezvous baud after applying an OTA image. */
    public static final long BES_OTA_RECONNECT_DELAY_MS = 2500;

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

    /**
     * ZSL preview/capture buffering kill switch. Disable only as an emergency; normal photo capture
     * uses ZSL by default.
     */
    public static final boolean ENABLE_ZSL = true;

    /**
     * Vendor MFNR (multi-frame noise reduction) kill switch. Disable only as an emergency; normal
     * photo capture uses MFNR by default.
     */
    public static final boolean ENABLE_MFNR = true;

    /** Default for photo requests when {@code zsl} is omitted. */
    public static final boolean DEFAULT_ZSL = true;

    /** Default for photo requests when {@code mfnr} is omitted. */
    public static final boolean DEFAULT_MFNR = true;

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

    /** Long-edge cap when text-mode detection produced a usable crop. */
    public static final int TEXT_MODE_BLE_TARGET_WIDTH = 2880;

    public static final int TEXT_MODE_BLE_TARGET_HEIGHT = 2880;

    /** Long-edge cap when text-mode detection falls back to the full frame. */
    public static final int TEXT_MODE_BLE_FALLBACK_TARGET_WIDTH = 1920;

    public static final int TEXT_MODE_BLE_FALLBACK_TARGET_HEIGHT = 1920;

    /** AVIF quality for the canonical text-mode BLE payload. */
    public static final int TEXT_MODE_AVIF_QUALITY = 55;

    /** JPEG quality for the canonical text-mode crop written to disk (gallery/WiFi upload). */
    public static final int TEXT_MODE_BLE_JPEG_QUALITY = 80;

    /** Long-edge size used for on-glasses ML Kit text localization. */
    // 1600 reliably retained small label/instruction text on real 4032x3024 Mentra Live captures
    // while remaining comfortably below the detector timeout.
    public static final int TEXT_MODE_MLKIT_ANALYSIS_LONG_EDGE = 1600;

    /** Minimum source-pixel padding around the union of ML Kit text lines. */
    public static final int TEXT_MODE_MLKIT_MIN_PADDING_PX = 32;

    /** Horizontal padding relative to the detected text-union width. */
    public static final float TEXT_MODE_MLKIT_PADDING_X_FRACTION = 0.12f;

    /** Vertical padding relative to the detected text-union height. */
    public static final float TEXT_MODE_MLKIT_PADDING_Y_FRACTION = 0.35f;

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
     * Log UART file-transfer send progress every N packets. {@code 0} = off (start/end/errors
     * only).
     */
    public static final int FILE_TRANSFER_PROGRESS_LOG_INTERVAL = 10;

    // Video capture thumbnails
    // -------------------------------------------------------------------------

    /** JPEG sidecar written next to a finalized video for direct-filesystem consumers. */
    public static final String VIDEO_THUMBNAIL_SIDECAR_NAME = "thumb.jpg";

    /** Transient thumbnail filename; the .partial suffix keeps it out of gallery listings. */
    public static final String VIDEO_THUMBNAIL_PARTIAL_NAME = "thumb.jpg.partial";

    /** Longest edge of generated video thumbnails, in pixels. */
    public static final int VIDEO_THUMBNAIL_MAX_DIMENSION = 480;

    /** JPEG compression quality for video thumbnail sidecars. */
    public static final int VIDEO_THUMBNAIL_JPEG_QUALITY = 80;

    /** Frame position sampled for video thumbnails, in microseconds. */
    public static final long VIDEO_THUMBNAIL_FRAME_TIME_US = 1_000_000L;

    /** Maximum time allowed for platform video-frame extraction. */
    public static final long VIDEO_THUMBNAIL_EXTRACTION_TIMEOUT_MS = 10_000L;

    /** Final main-thread wait after thumbnail work has drained during other cleanup steps. */
    public static final long VIDEO_THUMBNAIL_SHUTDOWN_TIMEOUT_MS = 250L;

    /** Maximum abandoned native decoder workers retained after timeout. */
    public static final int VIDEO_THUMBNAIL_MAX_RETIRED_DECODERS = 2;

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
