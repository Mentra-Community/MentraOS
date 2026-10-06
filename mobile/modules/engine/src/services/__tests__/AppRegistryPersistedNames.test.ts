import {beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

// Builds that already shipped wrote the "workspace" names below to device
// storage. In-memory names may change; these persisted names must not, or
// installed bundles, their provenance and their active-version selection are
// orphaned on upgrade.

const values = new Map<string, unknown>()
const installationValues = new Map<string, string>()
const directories = new Set<string>()
const files = new Map<string, string>()

const DOCUMENTS = "file:///test-documents"
const join = (parts: Array<string | {uri: string}>) =>
  parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/")
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"))

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
  getConfigValues: () => ({}),
  isDevMiniappAllowed: () => true,
  isInstalledMiniappAllowed: () => true,
  isMiniappAvailable: () => true,
  isLocalMiniappPackageAllowed: () => true,
  isOfflineSystemMiniappAllowed: () => true,
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSettingsStore: {getState: () => ({getSetting: () => false})},
}))
mock.module("expo/fetch", () => ({fetch: mock()}))
mock.module("expo-file-system", () => {
  class FakeDirectory {
    uri: string
    constructor(...parts: Array<string | {uri: string}>) {
      this.uri = join(parts)
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1)
    }
    get exists() {
      return directories.has(this.uri)
    }
    create() {
      directories.add(this.uri)
    }
    list() {
      return [
        ...[...directories].filter((path) => parentOf(path) === this.uri).map((path) => new FakeDirectory(path)),
        ...[...files.keys()].filter((path) => parentOf(path) === this.uri).map((path) => new FakeFile(path)),
      ]
    }
    delete() {
      for (const path of [...directories])
        if (path === this.uri || path.startsWith(`${this.uri}/`)) directories.delete(path)
      for (const path of [...files.keys()]) if (path.startsWith(`${this.uri}/`)) files.delete(path)
    }
  }
  class FakeFile {
    uri: string
    constructor(...parts: Array<string | {uri: string}>) {
      this.uri = join(parts)
    }
    get exists() {
      return files.has(this.uri)
    }
    textSync() {
      return files.get(this.uri)!
    }
    write(value: string) {
      files.set(this.uri, value)
    }
  }
  return {Directory: FakeDirectory, File: FakeFile, Paths: {cache: {list: () => []}, document: DOCUMENTS}}
})
mock.module("react-native-zip-archive", () => ({unzip: mock()}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))

const {default: registry} = await import("../AppRegistry")
const packageName = "com.example.managed"

function makeDirectory(...segments: string[]) {
  for (let end = 1; end <= segments.length; end++) directories.add(join([DOCUMENTS, ...segments.slice(0, end)]))
}

beforeEach(() => {
  values.clear()
  installationValues.clear()
  directories.clear()
  files.clear()
})

describe("shipped persisted names", () => {
  test("organization releases live under the lmas-workspace directory", () => {
    makeDirectory("lmas-workspace", packageName, "1.0.0")
    makeDirectory("lmas", packageName, "0.9.0")
    expect(registry.getPackageNames("organization")).toEqual([packageName])
    expect(registry.getInstalledVersions(packageName, "organization")).toEqual(["1.0.0"])
    expect(registry.getInstalledVersions(packageName, "consumer")).toEqual(["0.9.0"])
  })

  test("finalizing an organization install uses the shipped MMKV keys and journal fields", () => {
    const recorded: string[] = []
    registry["finalizeInstall"](
      packageName,
      "1.0.0",
      {source: "deployment_manifest", deploymentId: "enterprise", deploymentOrigin: "https://enterprise.example"},
      (state: string) => recorded.push(state),
      "organization",
    ).apply()

    expect(JSON.parse(installationValues.get(`miniapp_release_identity:workspace:${packageName}:1.0.0`)!)).toEqual({
      source: "deployment_manifest",
      deploymentId: "enterprise",
      deploymentOrigin: "https://enterprise.example",
    })
    expect(values.get(`${packageName}_workspace_active_version`)).toBe("1.0.0")
    expect(values.has(`${packageName}_active_version`)).toBe(false)
    expect(recorded).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        packageName,
        version: "1.0.0",
        publisher: {present: false},
        release: {present: false},
        active: {present: false},
        workspaceSelection: true,
        storageScope: "workspace",
      }),
    ])
  })

  test("recovery reads a journal written by a shipped build into the shipped keys", () => {
    makeDirectory("lmas-workspace", packageName, `.pending-existing-1.0.0-1700000000000`)
    files.set(
      join([
        DOCUMENTS,
        "lmas-workspace",
        packageName,
        ".pending-existing-1.0.0-1700000000000",
        "metadata-rollback.json",
      ]),
      JSON.stringify({
        schemaVersion: 1,
        packageName,
        version: "1.0.0",
        publisher: {present: false},
        release: {present: true, value: {source: "bundled_asset"}},
        active: {present: true, value: "1.0.0"},
        workspaceSelection: true,
        storageScope: "workspace",
      }),
    )
    values.set(`${packageName}_active_version`, "0.9.0")
    values.set(`${packageName}_workspace_active_version`, "1.0.1")

    registry["recoverInterruptedActivations"]()

    expect(values.get(`${packageName}_workspace_active_version`)).toBe("1.0.0")
    expect(values.get(`${packageName}_active_version`)).toBe("0.9.0")
    expect(JSON.parse(installationValues.get(`miniapp_release_identity:workspace:${packageName}:1.0.0`)!).source).toBe(
      "bundled_asset",
    )
  })

  test("recovery treats a journal without organization fields as the consumer selection", () => {
    makeDirectory("lmas", packageName, `.pending-existing-1.0.0-1700000000001`)
    files.set(
      join([DOCUMENTS, "lmas", packageName, ".pending-existing-1.0.0-1700000000001", "metadata-rollback.json"]),
      JSON.stringify({
        schemaVersion: 1,
        packageName,
        version: "1.0.0",
        publisher: {present: false},
        release: {present: false},
        active: {present: true, value: "1.0.0"},
      }),
    )
    values.set(`${packageName}_active_version`, "1.0.1")
    values.set(`${packageName}_workspace_active_version`, "2.0.0")

    registry["recoverInterruptedActivations"]()

    expect(values.get(`${packageName}_active_version`)).toBe("1.0.0")
    expect(values.get(`${packageName}_workspace_active_version`)).toBe("2.0.0")
  })
})
