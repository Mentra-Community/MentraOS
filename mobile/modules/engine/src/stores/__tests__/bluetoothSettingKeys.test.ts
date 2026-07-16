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
})
