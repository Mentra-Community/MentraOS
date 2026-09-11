/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MENTRA_LIVE_SETTING_KEYS} from "../bluetoothSettingKeys"

describe("MENTRA_LIVE_SETTING_KEYS", () => {
  test("syncs button video settings through the canonical atomic object", () => {
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("button_video_settings")
    expect(MENTRA_LIVE_SETTING_KEYS).not.toContain("button_video_width")
    expect(MENTRA_LIVE_SETTING_KEYS).not.toContain("button_video_height")
    expect(MENTRA_LIVE_SETTING_KEYS).not.toContain("button_video_fps")
  })

  test("includes Mentra Live mic gate toggles", () => {
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("voice_activity_detection_enabled")
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("loudness_gate_enabled")
  })
})
