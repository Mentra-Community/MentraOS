/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappErrorCode, MiniappRequestType, MiniappResponseType, MiniappStreamType} from "./protocol"

/**
 * These tests assert the exact wire values. Cross-process contract: any change
 * here must land in mobile/src/services/LocalMiniappRuntime.ts at the same
 * time. The whole point is catching accidental rename drift.
 */

describe("MiniappRequestType wire values", () => {
  test("CONNECT", () => expect(MiniappRequestType.CONNECT).toBe("miniapp_connect"))
  test("AUTH_REFRESH", () => expect(MiniappRequestType.AUTH_REFRESH).toBe("miniapp_auth_refresh"))
  test("SUBSCRIBE", () => expect(MiniappRequestType.SUBSCRIBE).toBe("miniapp_subscribe"))
  test("DISPLAY", () => expect(MiniappRequestType.DISPLAY).toBe("miniapp_display"))
  test("PLAY_AUDIO", () => expect(MiniappRequestType.PLAY_AUDIO).toBe("miniapp_play_audio"))
  test("STOP_AUDIO", () => expect(MiniappRequestType.STOP_AUDIO).toBe("miniapp_stop_audio"))
  test("SPEAK", () => expect(MiniappRequestType.SPEAK).toBe("miniapp_speak"))
  test("SPEAKER_STREAM_OPEN", () => expect(MiniappRequestType.SPEAKER_STREAM_OPEN).toBe("miniapp_speaker_stream_open"))
  test("SPEAKER_STREAM_WRITE", () =>
    expect(MiniappRequestType.SPEAKER_STREAM_WRITE).toBe("miniapp_speaker_stream_write"))
  test("SPEAKER_STREAM_CLOSE", () =>
    expect(MiniappRequestType.SPEAKER_STREAM_CLOSE).toBe("miniapp_speaker_stream_close"))
  test("SPEAKER_STREAM_ABORT", () =>
    expect(MiniappRequestType.SPEAKER_STREAM_ABORT).toBe("miniapp_speaker_stream_abort"))
  test("RGB_LED", () => expect(MiniappRequestType.RGB_LED).toBe("miniapp_rgb_led"))
  test("LOCATION_POLL", () => expect(MiniappRequestType.LOCATION_POLL).toBe("miniapp_location_poll"))
  test("CALENDAR_LIST_EVENTS", () =>
    expect(MiniappRequestType.CALENDAR_LIST_EVENTS).toBe("miniapp_calendar_list_events"))
  test("STORAGE_GET", () => expect(MiniappRequestType.STORAGE_GET).toBe("miniapp_storage_get"))
  test("STORAGE_SET", () => expect(MiniappRequestType.STORAGE_SET).toBe("miniapp_storage_set"))
  test("STORAGE_DELETE", () => expect(MiniappRequestType.STORAGE_DELETE).toBe("miniapp_storage_delete"))
  test("STORAGE_LIST", () => expect(MiniappRequestType.STORAGE_LIST).toBe("miniapp_storage_list"))
  test("CAMERA_FOV", () => expect(MiniappRequestType.CAMERA_FOV).toBe("miniapp_camera_fov"))
  test("IMU_SET_ENABLED", () => expect(MiniappRequestType.IMU_SET_ENABLED).toBe("miniapp_imu_set_enabled"))
  test("MIC_SET_VAD_ENABLED", () =>
    expect(MiniappRequestType.MIC_SET_VAD_ENABLED).toBe("miniapp_mic_set_vad_enabled"))
  test("MIC_SET_LOUDNESS_GATE_ENABLED", () =>
    expect(MiniappRequestType.MIC_SET_LOUDNESS_GATE_ENABLED).toBe("miniapp_mic_set_loudness_gate_enabled"))
  test("SET_WIFI_ADB_STATE", () =>
    expect(MiniappRequestType.SET_WIFI_ADB_STATE).toBe("miniapp_set_wifi_adb_state"))
  test("PING", () => expect(MiniappRequestType.PING).toBe("miniapp_ping"))
  test("DASHBOARD_CONTENT_UPDATE", () =>
    expect(MiniappRequestType.DASHBOARD_CONTENT_UPDATE).toBe("miniapp_dashboard_content_update"))
  test("PHOTO", () => expect(MiniappRequestType.PHOTO).toBe("miniapp_photo"))
  test("STREAM_START", () => expect(MiniappRequestType.STREAM_START).toBe("miniapp_stream_start"))
  test("STREAM_STOP", () => expect(MiniappRequestType.STREAM_STOP).toBe("miniapp_stream_stop"))
  test("MANAGED_STREAM_START", () =>
    expect(MiniappRequestType.MANAGED_STREAM_START).toBe("miniapp_managed_stream_start"))
  test("MANAGED_STREAM_STOP", () => expect(MiniappRequestType.MANAGED_STREAM_STOP).toBe("miniapp_managed_stream_stop"))
  test("SHARE", () => expect(MiniappRequestType.SHARE).toBe("miniapp_share"))
  test("OPEN_URL", () => expect(MiniappRequestType.OPEN_URL).toBe("miniapp_open_url"))
  test("COPY_CLIPBOARD", () => expect(MiniappRequestType.COPY_CLIPBOARD).toBe("miniapp_copy_clipboard"))
  test("DOWNLOAD", () => expect(MiniappRequestType.DOWNLOAD).toBe("miniapp_download"))
  test("SCAN_QR", () => expect(MiniappRequestType.SCAN_QR).toBe("miniapp_scan_qr"))
  test("MEETING_JOIN", () => expect(MiniappRequestType.MEETING_JOIN).toBe("miniapp_meeting_join"))
  test("MEETING_LEAVE", () => expect(MiniappRequestType.MEETING_LEAVE).toBe("miniapp_meeting_leave"))
  test("MEETING_SET_MUTED", () => expect(MiniappRequestType.MEETING_SET_MUTED).toBe("miniapp_meeting_set_muted"))
  test("MEETING_UPDATE_VIDEO_SOURCE", () =>
    expect(MiniappRequestType.MEETING_UPDATE_VIDEO_SOURCE).toBe("miniapp_meeting_update_video_source"))
  test("MEETING_GET_STATE", () => expect(MiniappRequestType.MEETING_GET_STATE).toBe("miniapp_meeting_get_state"))
})

describe("MiniappResponseType wire values", () => {
  test("CONNECT_ACK", () => expect(MiniappResponseType.CONNECT_ACK).toBe("miniapp_connect_ack"))
  test("EVENT", () => expect(MiniappResponseType.EVENT).toBe("miniapp_event"))
  test("REQUEST_RESULT", () => expect(MiniappResponseType.REQUEST_RESULT).toBe("miniapp_request_result"))
  test("CAPABILITIES_UPDATE", () => expect(MiniappResponseType.CAPABILITIES_UPDATE).toBe("miniapp_capabilities_update"))
  test("VISIBILITY_CHANGE", () => expect(MiniappResponseType.VISIBILITY_CHANGE).toBe("miniapp_visibility_change"))
  test("PONG", () => expect(MiniappResponseType.PONG).toBe("miniapp_pong"))
  test("ACTION_CALL", () => expect(MiniappResponseType.ACTION_CALL).toBe("miniapp_action_call"))
  test("MEETING_STATE", () => expect(MiniappResponseType.MEETING_STATE).toBe("miniapp_meeting_state"))
  test("ERROR", () => expect(MiniappResponseType.ERROR).toBe("miniapp_error"))
})

describe("MiniappStreamType wire values", () => {
  test("BUTTON_PRESS", () => expect(MiniappStreamType.BUTTON_PRESS).toBe("button_press"))
  test("TOUCH_EVENT", () => expect(MiniappStreamType.TOUCH_EVENT).toBe("touch_event"))
  test("HEAD_POSITION", () => expect(MiniappStreamType.HEAD_POSITION).toBe("head_position"))
  test("ACCEL_DATA", () => expect(MiniappStreamType.ACCEL_DATA).toBe("accel_data"))
  test("GLASSES_BATTERY", () => expect(MiniappStreamType.GLASSES_BATTERY).toBe("glasses_battery"))
  test("PHONE_BATTERY", () => expect(MiniappStreamType.PHONE_BATTERY).toBe("phone_battery"))
  test("GLASSES_CONNECTION", () => expect(MiniappStreamType.GLASSES_CONNECTION).toBe("glasses_connection"))
  test("TRANSCRIPTION", () => expect(MiniappStreamType.TRANSCRIPTION).toBe("transcription"))
  test("TRANSLATION", () => expect(MiniappStreamType.TRANSLATION).toBe("translation"))
  test("AUDIO_CHUNK", () => expect(MiniappStreamType.AUDIO_CHUNK).toBe("audio_chunk"))
  test("VAD is lowercase in miniapp protocol", () => expect(MiniappStreamType.VAD).toBe("vad"))
  test("LOCATION_UPDATE", () => expect(MiniappStreamType.LOCATION_UPDATE).toBe("location_update"))
  test("PHONE_NOTIFICATION", () => expect(MiniappStreamType.PHONE_NOTIFICATION).toBe("phone_notification"))
  test("PHOTO_TAKEN", () => expect(MiniappStreamType.PHOTO_TAKEN).toBe("photo_taken"))
  test("STREAM_STATUS", () => expect(MiniappStreamType.STREAM_STATUS).toBe("stream_status"))
})

describe("MiniappErrorCode wire values", () => {
  test("INVALID_ARGUMENT", () => expect(MiniappErrorCode.INVALID_ARGUMENT).toBe("INVALID_ARGUMENT"))
  test("PERMISSION_NOT_DECLARED", () =>
    expect(MiniappErrorCode.PERMISSION_NOT_DECLARED).toBe("PERMISSION_NOT_DECLARED"))
  test("PERMISSION_DENIED", () => expect(MiniappErrorCode.PERMISSION_DENIED).toBe("PERMISSION_DENIED"))
  test("NOT_IMPLEMENTED", () => expect(MiniappErrorCode.NOT_IMPLEMENTED).toBe("NOT_IMPLEMENTED"))
  test("REQUEST_ABORTED", () => expect(MiniappErrorCode.REQUEST_ABORTED).toBe("REQUEST_ABORTED"))
  test("INTERNAL", () => expect(MiniappErrorCode.INTERNAL).toBe("INTERNAL"))
  test("TTS_TEXT_TOO_LONG", () => expect(MiniappErrorCode.TTS_TEXT_TOO_LONG).toBe("TTS_TEXT_TOO_LONG"))
  test("TTS_INVALID_VOICE", () => expect(MiniappErrorCode.TTS_INVALID_VOICE).toBe("TTS_INVALID_VOICE"))
  test("TTS_UPSTREAM_ERROR", () => expect(MiniappErrorCode.TTS_UPSTREAM_ERROR).toBe("TTS_UPSTREAM_ERROR"))
  test("TTS_LOCAL_UNAVAILABLE", () => expect(MiniappErrorCode.TTS_LOCAL_UNAVAILABLE).toBe("TTS_LOCAL_UNAVAILABLE"))
  test("NOT_CONNECTED", () => expect(MiniappErrorCode.NOT_CONNECTED).toBe("NOT_CONNECTED"))
})
