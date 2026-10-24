import {beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

// A remote install may download its ZIP with the caller's downloader (a miniapp URL whose server may ask for
// sign-in). The installer still holds those bytes to its own size limit and expected SHA-256.
const values = new Map<string, unknown>()
const installationValues = new Map<string, string>()
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) => (values.has(key) ? Res.ok(values.get(key)) : Res.error(new Error("Missing key"))),
    save: (key: string, value: unknown) => {
      values.set(key, value)
      return Res.ok(undefined)
    },
    remove: (key: string) => {
      values.delete(key)
      return Res.ok(undefined)
    },
  },
}))
mock.module("react-native-mmkv", () => ({
  createMMKV: () => ({
    getString: (key: string) => installationValues.get(key),
    set: (key: string, value: string) => installationValues.set(key, value),
    remove: (key: string) => installationValues.delete(key),
  }),
}))
mock.module("../../runtime/bootstrap", () => ({
  assertMiniappDevelopmentAllowed: () => {},
  getConfigValues: () => ({}),
  isDevMiniappAllowed: () => true,
  isInstalledMiniappAllowed: () => true,
  isOfflineSystemMiniappAllowed: () => true,
  isMiniappAvailable: () => true,
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSettingsStore: {getState: () => ({getSetting: () => false})},
}))
const anonymousDownloads: string[] = []
mock.module("expo/fetch", () => ({
  fetch: async (url: string) => {
    anonymousDownloads.push(url)
    throw new Error("the anonymous download is not under test")
  },
}))
mock.module("expo-file-system", () => ({
  Directory: class {
    exists = false
    create() {}
    delete() {}
    list() {
      return []
    }
  },
  File: class {
    uri = "file:///test-cache/bundle.zip"
    exists = false
    write() {
      this.exists = true
    }
    delete() {
      this.exists = false
    }
  },
  Paths: {cache: {list: () => []}, document: "file:///test-documents"},
}))
// Validation is where downloaded bytes go next; reaching it with them proves the download was accepted.
let validated: Uint8Array[] = []
// Extraction checks each unpacked file's real path through Crust.
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: (path: string) => path}}))
mock.module("react-native-zip-archive", () => ({
  unzip: async () => {
    throw new Error("extraction stopped by test")
  },
}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))
const realValidation = await import("../validateInstallBundle")
mock.module("../validateInstallBundle", () => ({
  ...realValidation,
  validateInstallBundleArchive: async (bytes: Uint8Array) => {
    validated.push(bytes)
    return {packageName, version: "1.0.0"}
  },
}))

const {default: registry} = await import("../AppRegistry")
const {sha256Hex} = await import("../../utils/sha256")
const packageName = "com.acme.tools"
const zipUrl = "https://tools.acme.com/com.acme.tools-1.0.0.zip"
const bytes = Uint8Array.from([1, 2, 3, 4])

beforeEach(() => {
  values.clear()
  installationValues.clear()
  anonymousDownloads.length = 0
  validated = []
})

describe("a caller's bundle downloader", () => {
  test("downloads instead of the anonymous request, and its bytes are what installs", async () => {
    const asked: string[] = []
    const result = await registry.installFromUrl(zipUrl, {
      expectedPackageName: packageName,
      expectedVersion: "1.0.0",
      expectedBundleSha256: await sha256Hex(bytes),
      downloadBundle: async (url) => {
        asked.push(url)
        return bytes
      },
    })
    expect(result.is_error() && result.error.message).toBe("UNZIP_FAILED")
    expect(asked).toEqual([zipUrl])
    expect(anonymousDownloads).toEqual([])
    expect(validated).toEqual([bytes])
  })

  test("bytes with another SHA-256 are refused before anything reads them", async () => {
    const result = await registry.installFromUrl(zipUrl, {
      expectedBundleSha256: "0".repeat(64),
      downloadBundle: async () => bytes,
    })
    expect(result.is_error() && result.error.message).toContain("bundle SHA-256 mismatch")
    expect(validated).toEqual([])
  })

  test("an empty download is refused", async () => {
    const result = await registry.installFromUrl(zipUrl, {downloadBundle: async () => new Uint8Array()})
    expect(result.is_error() && result.error.message).toContain("bundle must be between 1 and")
    expect(validated).toEqual([])
  })

  test("its failure is the install's", async () => {
    const failure = new Error("the server refused the token")
    const result = await registry.installFromUrl(zipUrl, {
      downloadBundle: async () => {
        throw failure
      },
    })
    expect(result.is_error() && result.error).toBe(failure)
  })
})
