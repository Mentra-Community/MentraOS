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
  test("SUBSCRIBE", () => expect(MiniappRequestType.SUBSCRIBE).toBe("miniapp_subscribe"))
  test("DISPLAY", () => expect(MiniappRequestType.DISPLAY).toBe("miniapp_display"))
  test("PLAY_AUDIO", () => expect(MiniappRequestType.PLAY_AUDIO).toBe("miniapp_play_audio"))
  test("STOP_AUDIO", () => expect(MiniappRequestType.STOP_AUDIO).toBe("miniapp_stop_audio"))
  test("SPEAK", () => expect(MiniappRequestType.SPEAK).toBe("miniapp_speak"))
  test("RGB_LED", () => expect(MiniappRequestType.RGB_LED).toBe("miniapp_rgb_led"))
  test("LOCATION_POLL", () => expect(MiniappRequestType.LOCATION_POLL).toBe("miniapp_location_poll"))
  test("STORAGE_GET", () => expect(MiniappRequestType.STORAGE_GET).toBe("miniapp_storage_get"))
  test("STORAGE_SET", () => expect(MiniappRequestType.STORAGE_SET).toBe("miniapp_storage_set"))
  test("STORAGE_DELETE", () => expect(MiniappRequestType.STORAGE_DELETE).toBe("miniapp_storage_delete"))
  test("STORAGE_LIST", () => expect(MiniappRequestType.STORAGE_LIST).toBe("miniapp_storage_list"))
  test("CAMERA_FOV", () => expect(MiniappRequestType.CAMERA_FOV).toBe("miniapp_camera_fov"))
  test("PING", () => expect(MiniappRequestType.PING).toBe("miniapp_ping"))
  test("DASHBOARD_CONTENT_UPDATE", () =>
    expect(MiniappRequestType.DASHBOARD_CONTENT_UPDATE).toBe("miniapp_dashboard_content_update"))
  test("PHOTO", () => expect(MiniappRequestType.PHOTO).toBe("miniapp_photo"))
  test("STREAM_START", () => expect(MiniappRequestType.STREAM_START).toBe("miniapp_stream_start"))
  test("STREAM_STOP", () => expect(MiniappRequestType.STREAM_STOP).toBe("miniapp_stream_stop"))
  test("MANAGED_STREAM_START", () =>
    expect(MiniappRequestType.MANAGED_STREAM_START).toBe("miniapp_managed_stream_start"))
  test("MANAGED_STREAM_STOP", () =>
    expect(MiniappRequestType.MANAGED_STREAM_STOP).toBe("miniapp_managed_stream_stop"))
  test("SHARE", () => expect(MiniappRequestType.SHARE).toBe("miniapp_share"))
  test("OPEN_URL", () => expect(MiniappRequestType.OPEN_URL).toBe("miniapp_open_url"))
  test("COPY_CLIPBOARD", () => expect(MiniappRequestType.COPY_CLIPBOARD).toBe("miniapp_copy_clipboard"))
  test("DOWNLOAD", () => expect(MiniappRequestType.DOWNLOAD).toBe("miniapp_download"))
})

describe("MiniappResponseType wire values", () => {
  test("CONNECT_ACK", () => expect(MiniappResponseType.CONNECT_ACK).toBe("miniapp_connect_ack"))
  test("EVENT", () => expect(MiniappResponseType.EVENT).toBe("miniapp_event"))
  test("REQUEST_RESULT", () => expect(MiniappResponseType.REQUEST_RESULT).toBe("miniapp_request_result"))
  test("CAPABILITIES_UPDATE", () =>
    expect(MiniappResponseType.CAPABILITIES_UPDATE).toBe("miniapp_capabilities_update"))
  test("VISIBILITY_CHANGE", () =>
    expect(MiniappResponseType.VISIBILITY_CHANGE).toBe("miniapp_visibility_change"))
  test("PONG", () => expect(MiniappResponseType.PONG).toBe("miniapp_pong"))
  test("ERROR", () => expect(MiniappResponseType.ERROR).toBe("miniapp_error"))
})

describe("MiniappStreamType wire values", () => {
  test("BUTTON_PRESS", () => expect(MiniappStreamType.BUTTON_PRESS).toBe("button_press"))
  test("TOUCH_EVENT", () => expect(MiniappStreamType.TOUCH_EVENT).toBe("touch_event"))
  test("HEAD_POSITION", () => expect(MiniappStreamType.HEAD_POSITION).toBe("head_position"))
  test("GLASSES_BATTERY", () => expect(MiniappStreamType.GLASSES_BATTERY).toBe("glasses_battery"))
  test("PHONE_BATTERY", () => expect(MiniappStreamType.PHONE_BATTERY).toBe("phone_battery"))
  test("GLASSES_CONNECTION", () => expect(MiniappStreamType.GLASSES_CONNECTION).toBe("glasses_connection"))
  test("TRANSCRIPTION", () => expect(MiniappStreamType.TRANSCRIPTION).toBe("transcription"))
  test("TRANSLATION", () => expect(MiniappStreamType.TRANSLATION).toBe("translation"))
  test("AUDIO_CHUNK", () => expect(MiniappStreamType.AUDIO_CHUNK).toBe("audio_chunk"))
  test("VAD is lowercase in miniapp protocol", () => expect(MiniappStreamType.VAD).toBe("vad"))
  test("LOCATION_UPDATE", () => expect(MiniappStreamType.LOCATION_UPDATE).toBe("location_update"))
  test("PHONE_NOTIFICATION", () => expect(MiniappStreamType.PHONE_NOTIFICATION).toBe("phone_notification"))
  test("CALENDAR_EVENT", () => expect(MiniappStreamType.CALENDAR_EVENT).toBe("calendar_event"))
  test("PHOTO_TAKEN", () => expect(MiniappStreamType.PHOTO_TAKEN).toBe("photo_taken"))
  test("STREAM_STATUS", () => expect(MiniappStreamType.STREAM_STATUS).toBe("stream_status"))
})

describe("MiniappErrorCode wire values", () => {
  test("PERMISSION_NOT_DECLARED", () =>
    expect(MiniappErrorCode.PERMISSION_NOT_DECLARED).toBe("PERMISSION_NOT_DECLARED"))
  test("NOT_IMPLEMENTED", () => expect(MiniappErrorCode.NOT_IMPLEMENTED).toBe("NOT_IMPLEMENTED"))
  test("REQUEST_ABORTED", () => expect(MiniappErrorCode.REQUEST_ABORTED).toBe("REQUEST_ABORTED"))
  test("INTERNAL", () => expect(MiniappErrorCode.INTERNAL).toBe("INTERNAL"))
  test("TTS_TEXT_TOO_LONG", () => expect(MiniappErrorCode.TTS_TEXT_TOO_LONG).toBe("TTS_TEXT_TOO_LONG"))
  test("TTS_INVALID_VOICE", () => expect(MiniappErrorCode.TTS_INVALID_VOICE).toBe("TTS_INVALID_VOICE"))
  test("TTS_UPSTREAM_ERROR", () => expect(MiniappErrorCode.TTS_UPSTREAM_ERROR).toBe("TTS_UPSTREAM_ERROR"))
  test("NOT_CONNECTED", () => expect(MiniappErrorCode.NOT_CONNECTED).toBe("NOT_CONNECTED"))
})
