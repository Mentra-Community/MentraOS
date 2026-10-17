import {expect, test} from "bun:test"
import {packagedBackendTarget} from "./packagedBackendTarget"

test("packaged metadata must match the compiled build environment", () => {
  expect(
    packagedBackendTarget(
      {mentraBackendTarget: {schemaVersion: 1, coreUrl: "https://core.staging.us-west-2.mentraglass.com"}},
      "https://core.staging.us-west-2.mentraglass.com",
    ),
  ).toBe("https://core.staging.us-west-2.mentraglass.com")
  expect(() =>
    packagedBackendTarget(
      {mentraBackendTarget: {schemaVersion: 1, coreUrl: "https://core.staging.us-west-2.mentraglass.com"}},
      "https://core.dev.us-west-2.mentraglass.com",
    ),
  ).toThrow("compiled build baseline")
  expect(packagedBackendTarget(undefined, "https://local.example")).toBe("https://local.example")
})
test.each(["file:///private", "https://user:secret@core.example"])(
  "reject an unsupported packaged target %s",
  (coreUrl) => {
    expect(() => packagedBackendTarget({mentraBackendTarget: {schemaVersion: 1, coreUrl}})).toThrow()
  },
)
test("embedding preserves existing local/custom service path and port behavior", () => {
  expect(
    packagedBackendTarget(
      {mentraBackendTarget: {schemaVersion: 1, coreUrl: "http://localhost:3000/core"}},
      "http://localhost:3000/core",
    ),
  ).toBe("http://localhost:3000/core")
})
