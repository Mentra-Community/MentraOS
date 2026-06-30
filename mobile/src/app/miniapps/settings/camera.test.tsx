/// <reference types="bun-types" />

import {readFileSync} from "node:fs"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"
import {describe, expect, test} from "bun:test"

const cameraSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "camera.tsx"), "utf8")

describe("camera settings BLE writes", () => {
  test("does not duplicate BLE writes — relies on settings store subscription", () => {
    expect(cameraSource).not.toContain("updateBluetoothSettings")
    expect(cameraSource).not.toContain("button_video_width")
    expect(cameraSource).not.toContain("button_video_height")
    expect(cameraSource).not.toContain("button_video_fps")
  })
})
