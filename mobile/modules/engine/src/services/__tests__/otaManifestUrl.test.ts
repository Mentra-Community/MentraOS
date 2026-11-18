/// <reference types="bun-types" />

import {beforeEach, expect, mock, test} from "bun:test"

const settings: Record<string, unknown> = {}
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}, ota_version_url: {key: "ota_version_url"}},
  useSettingsStore: {
    getState: () => ({
      getSetting: (key: string) => settings[key],
      setSetting: async (key: string, value: unknown) => {
        settings[key] = value
      },
    }),
  },
}))
mock.module("../../runtime/bootstrap", () => ({getConfigValues: () => ({})}))
mock.module("../../generated/releaseMetadata", () => ({
  ENGINE_RELEASE_METADATA: {otaManifestUrl: "https://ota.example.com/pin.json"},
}))

const {resolveOtaManifestUrl} = await import("../otaManifestUrl")

beforeEach(() => {
  settings.super_mode = true
  settings.ota_version_url = "https://ota.example.com/older-set.json"
})

test("glasses that can take a URL get the override", () => {
  expect(resolveOtaManifestUrl(null, "39")).toBe("https://ota.example.com/older-set.json")
  expect(settings.ota_version_url).toBe("https://ota.example.com/older-set.json")
})

test("glasses that can't take a URL are up to date while an override is set, whatever asks", () => {
  expect(resolveOtaManifestUrl(null, "37")).toBeNull()
  expect(resolveOtaManifestUrl("https://ota.mentraglass.com/device.json", "36")).toBeNull()
  expect(settings.ota_version_url).toBe("https://ota.example.com/older-set.json")
})

test("once the override is cleared, they follow production", () => {
  settings.ota_version_url = null
  expect(resolveOtaManifestUrl(null, "37")).toBe("https://ota.mentraglass.com/prod_live_version.json")
})
