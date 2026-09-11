/// <reference types="bun-types" />

import {readFileSync} from "node:fs"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"
import {describe, expect, test} from "bun:test"

// Kept outside src/app/ so the Expo Router require.context does not bundle this
// node-only test into the release JS bundle (Hermes cannot parse import.meta).
const cameraSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../app/miniapps/settings/camera.tsx"),
  "utf8",
)

describe("camera settings BLE writes", () => {
  test("does not duplicate BLE writes — relies on settings store subscription", () => {
    expect(cameraSource).not.toContain("updateBluetoothSettings")
    expect(cameraSource).not.toContain("button_video_width")
    expect(cameraSource).not.toContain("button_video_height")
    expect(cameraSource).not.toContain("button_video_fps")
  })
})
