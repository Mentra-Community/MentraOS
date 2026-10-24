import {beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

// A miniapp that moved (a permanent redirect within its domain) records its new URL on the installed release.
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
mock.module("expo/fetch", () => ({
  fetch: async () => {
    throw new Error("nothing downloads here")
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
  File: class {},
  Paths: {cache: {list: () => []}, document: "file:///test-documents"},
}))
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: (path: string) => path}}))
mock.module("react-native-zip-archive", () => ({unzip: async () => ""}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))

const {default: registry} = await import("../AppRegistry")
type MiniappReleaseIdentity = import("../AppRegistry").MiniappReleaseIdentity

const packageName = "com.acme.tools"
const oldUrl = "https://tools.acme.com/app/"
const newUrl = "https://apps.acme.com/tools/"
const key = `miniapp_release_identity:${packageName}:1.0.0`

function storeIdentity(identity: MiniappReleaseIdentity): void {
  installationValues.set(key, JSON.stringify(identity))
}

beforeEach(() => {
  values.clear()
  installationValues.clear()
})

describe("setReleaseSourceUrl", () => {
  test("changes only the URL a release updates from", () => {
    storeIdentity({source: "url", sourceUrl: oldUrl, bundleSha256: "a".repeat(64), private: true})
    expect(registry.setReleaseSourceUrl(packageName, "1.0.0", oldUrl, newUrl)).toBe(true)
    expect(registry.getReleaseIdentity(packageName, "1.0.0")).toEqual({
      source: "url",
      sourceUrl: newUrl,
      bundleSha256: "a".repeat(64),
      private: true,
    })
  })

  test("leaves a release that no longer records the old URL alone", () => {
    storeIdentity({source: "url", sourceUrl: "https://tools.acme.com/v3/"})
    expect(registry.setReleaseSourceUrl(packageName, "1.0.0", oldUrl, newUrl)).toBe(false)
    expect(registry.getReleaseIdentity(packageName, "1.0.0")?.sourceUrl).toBe("https://tools.acme.com/v3/")
  })

  test("never gives a release of another source a URL", () => {
    storeIdentity({source: "bundled_asset"})
    expect(registry.setReleaseSourceUrl(packageName, "1.0.0", oldUrl, newUrl)).toBe(false)
    expect(registry.getReleaseIdentity(packageName, "1.0.0")).toEqual({source: "bundled_asset"})
    expect(registry.setReleaseSourceUrl(packageName, "2.0.0", oldUrl, newUrl)).toBe(false)
    expect(installationValues.has(`miniapp_release_identity:${packageName}:2.0.0`)).toBe(false)
  })
})
