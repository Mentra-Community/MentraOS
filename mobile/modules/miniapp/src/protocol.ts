/**
 * @fileoverview Wire protocol for @mentra/miniapp.
 *
 * Fresh miniapp-naming enum values. No legacy tpa_/app_/applet_ prefixes.
 * These values are the contract between @mentra/miniapp (running in a WebView)
 * and LocalMiniappRuntime (running on the phone).
 *
 * IMPORTANT: This file has NO runtime dependency on @mentra/sdk. The cloud SDK's
 * wire protocol enums live in @mentra/sdk/types/message-types.ts and are used
 * for cloud↔app communication, not phone↔miniapp.
 */

// ============================================================================
// Miniapp → phone (request, via bridge envelope)
// ============================================================================

export enum MiniappRequestType {
  /** Handshake: miniapp announces itself and asks phone to bind the session. */
  CONNECT = "miniapp_connect",

  /** Update the set of streams the miniapp is subscribed to. */
  SUBSCRIBE = "miniapp_subscribe",

  /** Push a layout to the glasses display. */
  DISPLAY = "miniapp_display",

  /** Play an arbitrary audio URL through the phone's audio playback service. */
  PLAY_AUDIO = "miniapp_play_audio",

  /** Stop any audio playback this miniapp initiated. */
  STOP_AUDIO = "miniapp_stop_audio",

  /** Speak text via cloud TTS — phone constructs the URL. */
  SPEAK = "miniapp_speak",

  /** Control the glasses RGB LED. */
  RGB_LED = "miniapp_rgb_led",

  /** One-shot location poll. */
  LOCATION_POLL = "miniapp_location_poll",

  /** Phone-local simple storage. */
  STORAGE_GET = "miniapp_storage_get",
  STORAGE_SET = "miniapp_storage_set",
  STORAGE_DELETE = "miniapp_storage_delete",
  STORAGE_LIST = "miniapp_storage_list",

  /** Write camera FOV settings. */
  CAMERA_FOV = "miniapp_camera_fov",

  /** Share content via the OS share sheet. */
  SHARE = "miniapp_share",
  /** Open a URL in the system browser. */
  OPEN_URL = "miniapp_open_url",
  /** Copy text to the system clipboard. */
  COPY_CLIPBOARD = "miniapp_copy_clipboard",
  /** Download a file (triggers OS share sheet for save location). */
  DOWNLOAD = "miniapp_download",

  /** Phone → miniapp liveness probe. Miniapp SDK auto-replies with PONG. */
  PING = "miniapp_ping",

  /**
   * Apply transcription configuration (language hints, vocabulary, diarization).
   * Phone forwards to the cloud STT layer. Fire-and-forget; cached client-side
   * so future reconnect logic can re-send.
   */
  TRANSCRIPTION_CONFIG = "miniapp_transcription_config",

  // ----- Deferred in v1 -----

  /** Dashboard content update. Noops in v1 — see Phase 2.14 of the plan. */
  DASHBOARD_CONTENT_UPDATE = "miniapp_dashboard_content_update",

  // ----- Phase 5 (photos, streaming) -----
  PHOTO = "miniapp_photo",
  STREAM_START = "miniapp_stream_start",
  STREAM_STOP = "miniapp_stream_stop",
  MANAGED_STREAM_START = "miniapp_managed_stream_start",
  MANAGED_STREAM_STOP = "miniapp_managed_stream_stop",
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

  /** Reply to PING. SDK auto-handles this; developers never see it. */
  PONG = "miniapp_pong",

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

  // Status
  GLASSES_BATTERY = "glasses_battery",
  PHONE_BATTERY = "phone_battery",
  GLASSES_CONNECTION = "glasses_connection",

  // Speech / audio (cloud or local)
  TRANSCRIPTION = "transcription", // language variant: "transcription:en-US"
  TRANSLATION = "translation", // language variant: "translation:en-US"
  AUDIO_CHUNK = "audio_chunk",
  VAD = "vad",

  // Phone sensors
  LOCATION_UPDATE = "location_update",
  PHONE_NOTIFICATION = "phone_notification",
  /**
   * A previously-posted notification was dismissed by the user.
   *
   * Android-only today. iOS does not expose dismiss callbacks to apps
   * (Apple privacy restriction); subscribing on iOS succeeds but no events
   * fire. See agents/miniapp-speaker-state-and-notif-dismissed-plan.md.
   */
  PHONE_NOTIFICATION_DISMISSED = "phone_notification_dismissed",
  CALENDAR_EVENT = "calendar_event",

  // Phase 5
  PHOTO_TAKEN = "photo_taken",
  STREAM_STATUS = "stream_status",
}

// ============================================================================
// Error codes
// ============================================================================

export enum MiniappErrorCode {
  /** The miniapp subscribed to a stream whose required permission wasn't in its manifest. */
  PERMISSION_NOT_DECLARED = "PERMISSION_NOT_DECLARED",

  /** Request routed to a method that isn't supported yet (e.g. Phase 5 noop). */
  NOT_IMPLEMENTED = "NOT_IMPLEMENTED",

  /** Request timed out or the session was torn down before it could complete. */
  REQUEST_ABORTED = "REQUEST_ABORTED",

  /** Phone-side code path threw. Check `message`. */
  INTERNAL = "INTERNAL",

  /** Cloud TTS returned a non-2xx for a SPEAK request. */
  TTS_TEXT_TOO_LONG = "TTS_TEXT_TOO_LONG",
  TTS_INVALID_VOICE = "TTS_INVALID_VOICE",
  TTS_UPSTREAM_ERROR = "TTS_UPSTREAM_ERROR",

  /** Not connected / pre-ACK and transport closed. */
  NOT_CONNECTED = "NOT_CONNECTED",
}
