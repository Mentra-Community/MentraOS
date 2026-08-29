/**
 * @fileoverview Wire protocol for @mentra/miniapp.
 *
 * Fresh miniapp-naming enum values. No legacy tpa_/app_/applet_ prefixes.
 * These values are the contract between @mentra/miniapp (running in a WebView)
 * and LocalMiniappRuntime (running on the phone).
 *
 * IMPORTANT: This file has no runtime dependency on the retired cloud SDK.
 * Its published wire-protocol enums are used only for compatibility with
 * existing cloud-hosted miniapps, not for phone↔miniapp communication.
 */

// ============================================================================
// Miniapp → phone (request, via bridge envelope)
// ============================================================================

export enum MiniappRequestType {
  /** Handshake: miniapp announces itself and asks phone to bind the session. */
  CONNECT = "miniapp_connect",

  /** Request a fresh miniapp-scoped backend auth token. */
  AUTH_REFRESH = "miniapp_auth_refresh",

  /** Update the set of streams the miniapp is subscribed to. */
  SUBSCRIBE = "miniapp_subscribe",

  /**
   * Push a legacy display layout to the glasses. The SDK no longer emits this
   * (render()/RENDER replaced it); hosts keep accepting it from bundles packed
   * with older SDKs and from cloud-shaped layouts.
   */
  DISPLAY = "miniapp_display",

  /** Render a whole scene of positioned elements (replace-the-frame). */
  RENDER = "miniapp_render",

  /** Play an arbitrary audio URL through the phone's audio playback service. */
  PLAY_AUDIO = "miniapp_play_audio",

  /** Stop any audio playback this miniapp initiated. */
  STOP_AUDIO = "miniapp_stop_audio",

  /** Speak text via cloud TTS — phone constructs the URL. */
  SPEAK = "miniapp_speak",

  /**
   * Live PCM output stream to the phone's audio playback service
   * (speaker.createStream). OPEN provisions a native chunk player; WRITE
   * appends base64 PCM (replies with {bufferedMs} for backpressure); CLOSE
   * drains and finishes; ABORT drops immediately.
   */
  SPEAKER_STREAM_OPEN = "miniapp_speaker_stream_open",
  SPEAKER_STREAM_WRITE = "miniapp_speaker_stream_write",
  SPEAKER_STREAM_CLOSE = "miniapp_speaker_stream_close",
  SPEAKER_STREAM_ABORT = "miniapp_speaker_stream_abort",

  /** Control the glasses RGB LED. */
  RGB_LED = "miniapp_rgb_led",

  /** One-shot location poll. */
  LOCATION_POLL = "miniapp_location_poll",

  /** Read a bounded snapshot of phone calendar events. */
  CALENDAR_LIST_EVENTS = "miniapp_calendar_list_events",

  /** Start a turn-by-turn navigation trip. Android only. */
  NAVIGATION_START = "miniapp_navigation_start",
  /** Stop the active navigation trip (if any). */
  NAVIGATION_STOP = "miniapp_navigation_stop",
  /** Dev-only: nudge the simulator off-route to test rerouting. Android sim only. */
  NAVIGATION_DEVIATE = "miniapp_navigation_deviate",
  /** Dev-only: lock simulated locations to the wrong sidewalk for pivot-trigger testing. */
  NAVIGATION_SET_WRONG_SIDEWALK = "miniapp_navigation_set_wrong_sidewalk",
  /** Dev-only: take over the simulator and walk a polyline with crossings stripped. */
  NAVIGATION_SET_SKIP_CROSSINGS = "miniapp_navigation_set_skip_crossings",
  /** Snapshot of the active trip (or null). Lets a miniapp opening mid-trip hydrate. */
  NAVIGATION_GET_STATE = "miniapp_navigation_get_state",
  /** Compute a route without starting a trip. Replaces hand-rolled Directions calls. */
  NAVIGATION_COMPUTE_ROUTE = "miniapp_navigation_compute_route",
  /** Reverse-geocode a coordinate to a short road name + full formatted
   *  address. `road` backs the engine's fallback for pivots whose Routes-API
   *  instruction didn't include a parseable road; `address` backs UI labels for
   *  dropped pins / POI taps. Resolved in the v2 cloud maps service (Mapbox
   *  today) via the host bridge — the miniapp never holds a maps token. */
  NAVIGATION_REVERSE_GEOCODE = "miniapp_navigation_reverse_geocode",
  /** Type-ahead place search (autocomplete). Resolved in the v2 cloud maps
   *  service (Mapbox Search Box today) via the host bridge — the miniapp never
   *  holds a maps token. Pairs with NAVIGATION_PLACE_DETAILS via a sessionToken. */
  NAVIGATION_PLACE_AUTOCOMPLETE = "miniapp_navigation_place_autocomplete",
  /** Resolve an autocomplete suggestion (placeId + sessionToken) to coordinates,
   *  in the v2 cloud maps service via the host bridge. */
  NAVIGATION_PLACE_DETAILS = "miniapp_navigation_place_details",
  /** Trigger the Google Nav SDK T&C dialog up-front so start() doesn't have to. */
  NAVIGATION_REQUEST_PERMISSION = "miniapp_navigation_request_permission",

  /** Phone-local simple storage. */
  STORAGE_GET = "miniapp_storage_get",
  STORAGE_SET = "miniapp_storage_set",
  STORAGE_DELETE = "miniapp_storage_delete",
  STORAGE_LIST = "miniapp_storage_list",
  STORAGE_CLEAR = "miniapp_storage_clear",
  STORAGE_HAS = "miniapp_storage_has",
  STORAGE_GET_ALL = "miniapp_storage_get_all",
  STORAGE_SET_MULTIPLE = "miniapp_storage_set_multiple",
  STORAGE_FLUSH = "miniapp_storage_flush",

  /** Write camera FOV settings. */
  CAMERA_FOV = "miniapp_camera_fov",

  /** Pre-warm the glasses camera so the next takePhoto() is near-instant. */
  CAMERA_WARM_UP = "miniapp_camera_warm_up",

  /**
   * Enable/disable raw accelerometer (IMU) streaming on the glasses. The
   * accel stream also auto-enables on subscribe; this is an explicit override
   * for callers who want to control the sensor directly. G2 only today.
   */
  IMU_SET_ENABLED = "miniapp_imu_set_enabled",

  /** Explicitly enable/disable glasses-side VAD (GX8002). Mirrors the app's mic settings toggle. */
  MIC_SET_VAD_ENABLED = "miniapp_mic_set_vad_enabled",
  /** Explicitly enable/disable the center-mic loudness gate ("Barrier"). */
  MIC_SET_LOUDNESS_GATE_ENABLED = "miniapp_mic_set_loudness_gate_enabled",

  /**
   * Enable or disable Wi-Fi ADB (wireless debugging) on Mentra Live.
   * SYSTEM-only — host rejects with NOT_PERMITTED for non-system callers.
   */
  SET_WIFI_ADB_STATE = "miniapp_set_wifi_adb_state",

  /** Share content via the OS share sheet. */
  SHARE = "miniapp_share",
  /** Open a URL in the system browser. */
  OPEN_URL = "miniapp_open_url",
  /** Copy text to the system clipboard. */
  COPY_CLIPBOARD = "miniapp_copy_clipboard",
  /** Download a file (triggers OS share sheet for save location). */
  DOWNLOAD = "miniapp_download",
  /**
   * Open a phone-camera QR scanner overlay. Host must not unmount the miniapp
   * (clearing foreground fires UI_CLOSE and can hang up live sessions).
   */
  SCAN_QR = "miniapp_scan_qr",

  /**
   * Phone-local persistent binary blob storage, scoped to (userId, packageName).
   * Unlike STORAGE_* (small string KV in MMKV), blobs are arbitrary bytes written
   * to the phone filesystem. Large payloads are moved in chunks (BLOB_WRITE /
   * BLOB_READ) so a single bridge message never carries a multi-MB string.
   */
  BLOB_CREATE = "miniapp_blob_create",
  BLOB_WRITE = "miniapp_blob_write",
  BLOB_COMMIT = "miniapp_blob_commit",
  BLOB_ABORT = "miniapp_blob_abort",
  BLOB_GET = "miniapp_blob_get",
  BLOB_LIST = "miniapp_blob_list",
  BLOB_DELETE = "miniapp_blob_delete",
  BLOB_CLEAR = "miniapp_blob_clear",
  BLOB_USAGE = "miniapp_blob_usage",
  BLOB_OPEN_READ = "miniapp_blob_open_read",
  BLOB_READ = "miniapp_blob_read",
  BLOB_CLOSE_READ = "miniapp_blob_close_read",
  /** Download a URL straight into a blob, host-side (no bytes cross the bridge). */
  BLOB_SET_FROM_URL = "miniapp_blob_set_from_url",
  /** Open the OS file picker and import the chosen file into a blob, host-side. */
  BLOB_IMPORT = "miniapp_blob_import",
  /** Share a stored blob from disk via the OS share sheet (no bytes cross the bridge). */
  BLOB_SHARE = "miniapp_blob_share",

  /** Phone → miniapp liveness probe. Miniapp SDK auto-replies with PONG. */
  PING = "miniapp_ping",

  /**
   * Apply transcription configuration (language hints, vocabulary, diarization).
   * Phone forwards to the cloud STT layer. Fire-and-forget; cached client-side
   * so future reconnect logic can re-send.
   */
  TRANSCRIPTION_CONFIG = "miniapp_transcription_config",

  // ----- Deferred in v1 -----

  /** Dashboard content update. Noop in v1. */
  DASHBOARD_CONTENT_UPDATE = "miniapp_dashboard_content_update",

  // ----- Photos, streaming -----
  PHOTO = "miniapp_photo",
  VIDEO_RECORDING_START = "miniapp_video_recording_start",
  VIDEO_RECORDING_STOP = "miniapp_video_recording_stop",
  STREAM_START = "miniapp_stream_start",
  STREAM_STOP = "miniapp_stream_stop",
  MANAGED_STREAM_START = "miniapp_managed_stream_start",
  MANAGED_STREAM_STOP = "miniapp_managed_stream_stop",

  /** Ask the host to open the glasses Wi-Fi setup flow (mirrors the cloud SDK's requestWifiSetup). */
  REQUEST_WIFI_SETUP = "miniapp_request_wifi_setup",

  // ----- Inter-miniapp interop (SYSTEM apps only) -----
  /** List installed miniapps (compatibility-filtered, with declared actions). */
  MINIAPPS_LIST = "miniapp_apps_list",
  /** Start another miniapp (user-tap semantics). */
  MINIAPPS_START = "miniapp_apps_start",
  /** Stop another miniapp. */
  MINIAPPS_STOP = "miniapp_apps_stop",
  /** Invoke a declared action on another miniapp; headless-wakes it if stopped. */
  ACTION_INVOKE = "miniapp_action_invoke",
  /** Target → host: the result of a delivered ACTION_CALL, correlated by callId. */
  ACTION_RESULT = "miniapp_action_result",
}

// ============================================================================
// Phone → miniapp (response or push)
// ============================================================================

export enum MiniappResponseType {
  /** Response to CONNECT carrying userId, packageName, capabilities. */
  CONNECT_ACK = "miniapp_connect_ack",

  /** Push: a streamed event for a subscribed stream. */
  EVENT = "miniapp_event",

  /** Response to any request that needs a result (matched by requestId). */
  REQUEST_RESULT = "miniapp_request_result",

  /** Push: glasses capabilities changed. */
  CAPABILITIES_UPDATE = "miniapp_capabilities_update",

  /** Push: miniapp's foreground/background state changed. */
  VISIBILITY_CHANGE = "miniapp_visibility_change",

  /** Push: host color scheme (light/dark) changed. */
  COLOR_SCHEME_CHANGE = "miniapp_color_scheme_change",

  /**
   * Push: speaker playback state transitioned. Per-miniapp; the runtime sends
   * to the owning miniapp only. Carries {state, errorCode?, errorMessage?,
   * durationMs?}. See SpeakerModule.onStateChange().
   */
  SPEAKER_STATE = "miniapp_speaker_state",

  /**
   * Push: manifest-declared permissions changed (e.g. dev miniapp re-scanned
   * with updated manifest). Carries a full PermissionRecord. SDK caches it
   * and fires session.permissions.onUpdate handlers.
   */
  PERMISSIONS_UPDATE = "miniapp_permissions_update",

  /**
   * Push: miniapp-scoped backend auth token changed. Carries a token minted for
   * this packageName only; it is never a Core or runtime access token.
   */
  AUTH_UPDATE = "miniapp_auth_update",

  /** Reply to PING. SDK auto-handles this; developers never see it. */
  PONG = "miniapp_pong",

  /**
   * Host → target: deliver an action call (from another miniapp's
   * session.actions.invoke) to this miniapp's session.actions.handle handler.
   * Carries {callId, actionId, params, callerPackageName}. The SDK runs the
   * handler and replies with an ACTION_RESULT request keyed by callId.
   */
  ACTION_CALL = "miniapp_action_call",

  /**
   * Push: phone is about to tear down the miniapp's session. Gives the SDK
   * a brief window (~50ms grace on the phone side) to fire one last
   * `sendOneShot` before the transport closes — used to flush final
   * cleanup like `display.render([])`. Synchronous handlers only.
   */
  WILL_DISCONNECT = "miniapp_will_disconnect",

  /** Async error not tied to a specific request. */
  ERROR = "miniapp_error",
}

// ============================================================================
// Stream types a miniapp can subscribe to
// ============================================================================

export enum MiniappStreamType {
  // Hardware / input events
  BUTTON_PRESS = "button_press",
  TOUCH_EVENT = "touch_event",
  HEAD_POSITION = "head_position",
  /**
   * Raw accelerometer reading from the glasses IMU — `{x, y, z}` in g, plus a
   * timestamp. G2 only today. A richer combined IMU stream (accel + gyro +
   * magnetometer) is future work; this is the single-sensor precursor.
   */
  ACCEL_DATA = "accel_data",

  // Status
  GLASSES_BATTERY = "glasses_battery",
  PHONE_BATTERY = "phone_battery",
  GLASSES_CONNECTION = "glasses_connection",
  /** Glasses Wi-Fi state (connected/ssid). Glasses with Wi-Fi only; needed for streaming. */
  GLASSES_WIFI = "glasses_wifi",

  // Speech / audio (cloud or local)
  TRANSCRIPTION = "transcription", // language variant: "transcription:en-US"
  TRANSLATION = "translation", // language variant: "translation:en-US"
  AUDIO_CHUNK = "audio_chunk",
  VAD = "vad",

  // Phone sensors
  LOCATION_UPDATE = "location_update",
  /** Compass heading in degrees (0=N, 90=E). Android only. */
  HEADING_UPDATE = "heading_update",
  /** Turn-by-turn navigation event (maneuver / rerouting / arrived / error). */
  NAVIGATION_UPDATE = "navigation_update",
  /** Active navigation route polyline — full path, fired once per route build. */
  NAVIGATION_ROUTE = "navigation_route",
  PHONE_NOTIFICATION = "phone_notification",
  /**
   * A previously-posted notification was dismissed by the user.
   *
   * Android-only today. iOS does not expose dismiss callbacks to apps
   * (Apple privacy restriction); subscribing on iOS succeeds but no events
   * fire. See agents/miniapp-speaker-state-and-notif-dismissed-plan.md.
   */
  PHONE_NOTIFICATION_DISMISSED = "phone_notification_dismissed",
  // Photos, streaming
  PHOTO_TAKEN = "photo_taken",
  STREAM_STATUS = "stream_status",
}

// ============================================================================
// Error codes
// ============================================================================

export enum MiniappErrorCode {
  /** Request arguments failed host-side validation. */
  INVALID_ARGUMENT = "INVALID_ARGUMENT",

  /** The miniapp subscribed to a stream whose required permission wasn't in its manifest. */
  PERMISSION_NOT_DECLARED = "PERMISSION_NOT_DECLARED",

  /** The required phone OS permission is not currently granted. */
  PERMISSION_DENIED = "PERMISSION_DENIED",

  /** Request routed to a method that isn't supported yet. */
  NOT_IMPLEMENTED = "NOT_IMPLEMENTED",

  /** Request timed out or the session was torn down before it could complete. */
  REQUEST_ABORTED = "REQUEST_ABORTED",

  /** Phone-side code path threw. Check `message`. */
  INTERNAL = "INTERNAL",

  /** Cloud TTS returned a non-2xx for a SPEAK request. */
  TTS_TEXT_TOO_LONG = "TTS_TEXT_TOO_LONG",
  TTS_INVALID_VOICE = "TTS_INVALID_VOICE",
  TTS_UPSTREAM_ERROR = "TTS_UPSTREAM_ERROR",

  /** `speak({forceLocal: true})` but the on-device offline TTS model isn't downloaded/ready. */
  TTS_LOCAL_UNAVAILABLE = "TTS_LOCAL_UNAVAILABLE",

  /** Not connected / pre-ACK and transport closed. */
  NOT_CONNECTED = "NOT_CONNECTED",

  // ----- Inter-miniapp interop -----
  /**
   * Caller is not a system app — SYSTEM-only APIs (interop list/start/stop/invoke,
   * setWifiAdbState) reject with this code.
   */
  NOT_PERMITTED = "NOT_PERMITTED",
  /** Target miniapp is not installed. */
  APP_NOT_FOUND = "APP_NOT_FOUND",
  /** Target miniapp is incompatible with the connected glasses. */
  APP_NOT_COMPATIBLE = "APP_NOT_COMPATIBLE",
  /** Target miniapp does not declare the requested action. */
  ACTION_NOT_FOUND = "ACTION_NOT_FOUND",
  /** Target connected but never registered a handler for the action (within the buffer window). */
  NO_ACTION_HANDLER = "NO_ACTION_HANDLER",
  /** Target failed to wake / complete its CONNECT handshake for an invoke. */
  WAKE_FAILED = "WAKE_FAILED",
  /** Action handler did not return within the caller's timeout. */
  ACTION_TIMEOUT = "ACTION_TIMEOUT",
  /** Action params or result exceeded the 256 KB size cap. */
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",

  // ----- Blob storage / recorder -----
  /** No blob with the given id in this miniapp's namespace. */
  BLOB_NOT_FOUND = "BLOB_NOT_FOUND",
  /** Writing this blob would exceed the per-app blob quota. */
  BLOB_QUOTA_EXCEEDED = "BLOB_QUOTA_EXCEEDED",
  /** Blob is larger than the requested in-memory read can hold. */
  BLOB_TOO_LARGE = "BLOB_TOO_LARGE",
  /** Write/read handle is unknown, already settled, or belongs to another app. */
  BLOB_HANDLE_INVALID = "BLOB_HANDLE_INVALID",
  /** Filesystem write failed (out of disk, permissions, etc.). */
  BLOB_WRITE_FAILED = "BLOB_WRITE_FAILED",
  /** `blob.setFromUrl` could not download the URL (network / non-2xx). */
  BLOB_DOWNLOAD_FAILED = "BLOB_DOWNLOAD_FAILED",
  /** `blob.importFile` failed (not the user cancelling — that resolves to null). */
  BLOB_IMPORT_FAILED = "BLOB_IMPORT_FAILED",
}
