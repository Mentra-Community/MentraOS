import {firmwareUpdates} from "@/../modules/engine/src/facades/firmwareUpdates"
import {configure, resetForTests} from "@/../modules/engine/src/runtime/bootstrap"
import {MANAGED_AR99_OTA_ENABLED} from "@/services/ar99ApiConfig"

afterEach(resetForTests)

it("keeps AR99 managed OTA disabled by default while preserving Live and NIMO entry points", () => {
  resetForTests()
  expect(MANAGED_AR99_OTA_ENABLED).toBe(false)
  expect(firmwareUpdates.supports("AR99", "settings")).toBe(false)
  expect(firmwareUpdates.supports("Mentra Live", "settings")).toBe(true)
  expect(firmwareUpdates.supports("NIMO", "pairing")).toBe(true)
})

it("requires an explicitly authorized AR99 source and still honors workspace network denial", () => {
  const vendorSources = {ar99: {baseUrl: "https://example.invalid/", developerId: "test", clientKey: "test"}}
  configure({auth: {}, config: {firmwareSources: {allowBundled: true, vendorSources}}})
  expect(firmwareUpdates.supports("AR99", "settings")).toBe(true)
  configure({auth: {}, config: {firmwareSources: {allowBundled: false, vendorSources}}})
  expect(firmwareUpdates.supports("AR99", "settings")).toBe(false)
})

it("does not enable managed AR99 for malformed optional vendor configuration", () => {
  configure({auth: {}, config: {firmwareSources: {vendorSources: {ar99: {baseUrl: "invalid"}}}}})
  expect(firmwareUpdates.supports("AR99", "settings")).toBe(false)
})
