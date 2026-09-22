import {beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import type {MiniappReleaseIdentity} from "../AppRegistry"
import {assertPublisherIdentityPolicy} from "../publisherIdentityPolicy"

const values = new Map<string, unknown>()
let failedWrite: string | undefined
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) => (values.has(key) ? Res.ok(values.get(key)) : Res.error(new Error("Missing key"))),
    save: (key: string, value: unknown) => {
      if (key === failedWrite) return Res.error(new Error("Storage write failed"))
      values.set(key, value)
      return Res.ok(undefined)
    },
    remove: (key: string) => {
      values.delete(key)
      return Res.ok(undefined)
    },
  },
}))
mock.module("../../runtime/bootstrap", () => ({
  getConfigValues: () => ({}),
  isInstalledMiniappAllowed: () => true,
  isOfflineSystemMiniappAllowed: () => true,
}))
mock.module("expo/fetch", () => ({fetch: mock()}))
mock.module("expo-file-system", () => ({
  Directory: class {
    exists = false
  },
  File: class {},
  Paths: {cache: {list: () => []}, document: "file:///test-documents"},
}))
mock.module("react-native-zip-archive", () => ({unzip: mock()}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))

// Exercise the real metadata transaction, with only native I/O replaced. The
// fingerprints represent already-verified metadata; no bundle is signed here.
const {default: registry} = await import("../AppRegistry")
const packageName = "com.example.publisher"
const publisherKey = `miniapp_publisher_identity:${packageName}`
const activeKey = `${packageName}_active_version`

function finalize(version: string, identity: MiniappReleaseIdentity) {
  return registry["finalizeInstall"](packageName, version, identity, () => {})
}

beforeEach(() => {
  values.clear()
  failedWrite = undefined
})

describe("AppRegistry publisher identity finalization", () => {
  for (const installedFingerprint of [undefined, "publisher-a"]) {
    for (const candidateFingerprint of [undefined, "publisher-b"]) {
      test(`dev snapshot ${candidateFingerprint ?? "unsigned"} preserves ${installedFingerprint ?? "no pin"}`, () => {
        if (installedFingerprint) values.set(publisherKey, installedFingerprint)
        const identity: MiniappReleaseIdentity = {source: "dev_snapshot", publisherKeyFingerprint: candidateFingerprint}
        finalize("dev-123", identity).apply()

        expect(registry.getPublisherKeyFingerprint(packageName)).toBe(installedFingerprint ?? null)
        expect(registry.getReleaseIdentity(packageName, "dev-123")).toEqual(identity)
        expect(values.get(activeKey)).toBe("dev-123")

        const validateRelease = (fingerprint: string) =>
          assertPublisherIdentityPolicy({
            packageName,
            source: "store",
            system: false,
            candidateFingerprint: fingerprint,
            installedFingerprint: registry.getPublisherKeyFingerprint(packageName),
          })
        expect(() => validateRelease("publisher-a")).not.toThrow()
        if (installedFingerprint) expect(() => validateRelease("publisher-b")).toThrow("signature mismatch")

        finalize("1.0.0", {source: "store", publisherKeyFingerprint: "publisher-a"}).apply()
        expect(registry.getPublisherKeyFingerprint(packageName)).toBe("publisher-a")
      })
    }
  }

  test("restores the production pin and release metadata if snapshot activation fails", () => {
    values.set(publisherKey, "publisher-a")
    values.set(activeKey, "1.0.0")
    const before = new Map(values)
    const transaction = finalize("dev-123", {source: "dev_snapshot", publisherKeyFingerprint: "publisher-b"})
    failedWrite = activeKey
    expect(() => transaction.apply()).toThrow("Storage write failed")
    failedWrite = undefined
    transaction.rollback()
    expect(values).toEqual(before)
  })
})
