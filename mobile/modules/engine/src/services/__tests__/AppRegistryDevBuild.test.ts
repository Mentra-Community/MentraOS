import {beforeEach, describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"
import {result as Res} from "typesafe-ts"

import type {MiniappReleaseIdentity} from "../AppRegistry"

// A dev build of a package is that package: the phone applies the Android
// signer rule to it and Core mints its token like any installed miniapp's.
;(globalThis as {__DEV__?: boolean}).__DEV__ = false
const values = new Map<string, unknown>()
const installationValues = new Map<string, string>()
let candidateFingerprint: string | undefined
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
// Downloads succeed; the archive's verified identity comes from the mocked
// validator so each test chooses whether the candidate bundle is signed.
mock.module("expo/fetch", () => ({
  fetch: async (url: string) => {
    let read = false
    return {
      ok: true,
      url,
      headers: {get: () => null},
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return {done: true}
            read = true
            return {done: false, value: Uint8Array.from([1, 2, 3])}
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    }
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
    async bytes() {
      return Uint8Array.from([1, 2, 3])
    }
  },
  Paths: {cache: {list: () => []}, document: "file:///test-documents"},
}))
// Extraction is where an accepted bundle goes next. Reaching it proves the
// publisher gate let the candidate through.
let extractions = 0
mock.module("react-native-zip-archive", () => ({
  unzip: async () => {
    extractions += 1
    throw new Error("extraction stopped by test")
  },
}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))
const realValidation = await import("../validateInstallBundle")
mock.module("../validateInstallBundle", () => ({
  ...realValidation,
  validateInstallBundleArchive: async () => ({
    packageName,
    version: "1.0.0",
    ...(candidateFingerprint ? {publisherKeyFingerprint: candidateFingerprint} : {}),
  }),
}))

const {
  default: registry,
  assertDevBuildAllowed,
  getDevAppRecords,
  getDevAppSourcePackage,
  registerDevApp,
  SignedMiniappDevBuildError,
} = await import("../AppRegistry")

const packageName = "com.example.devbuild"
const devRecord = {packageName, name: "Dev Build", iconUrl: "", devUrl: "http://192.168.1.20:3000", devPort: 3001}

function install(version: string, identity: MiniappReleaseIdentity) {
  registry["finalizeInstall"](packageName, version, identity, () => {}).apply()
}

function installDevSnapshot() {
  return registry.installFromUrl("http://192.168.1.20:3000/bundle.zip", {
    expectedPackageName: packageName,
    versionOverride: "dev-1000",
    releaseIdentity: {source: "dev_snapshot"},
  })
}

/** The runtime's real token-request method, run against a recording Cloud Client. */
function tokenRequester() {
  const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
  const start = source.search(/^  private async requestMiniappAuth\(/m)
  if (start < 0) throw new Error("Missing requestMiniappAuth")
  const rest = source.slice(start)
  const method = rest.slice(0, rest.search(/^  }$/m) + 3)
  const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${method} }`)
  const calls: unknown[][] = []
  const cloudClientService = {
    hasCore: () => true,
    getMiniappAuthToken: async (...args: unknown[]) => {
      calls.push(args)
      return {token: "miniapp-token"}
    },
  }
  const Host = new Function("cloudClientService", "getDevAppSourcePackage", `${compiled}; return Host`)(
    cloudClientService,
    getDevAppSourcePackage,
  )
  return {host: new Host() as {requestMiniappAuth(pkg: string, opts?: unknown): Promise<unknown>}, calls}
}

beforeEach(() => {
  values.clear()
  installationValues.clear()
  candidateFingerprint = undefined
  extractions = 0
})

describe("live dev builds follow the installed signer", () => {
  test("run when the package is not installed", async () => {
    await registerDevApp(devRecord)
    expect(values.get(`${packageName}_dev_url`)).toBe(devRecord.devUrl)
  })

  test("unsigned installed X + unsigned dev X: allowed, marked as a dev build, token minted for X", async () => {
    install("1.0.0", {source: "store"})
    expect(registry.getPublisherKeyFingerprint(packageName)).toBeNull()

    await registerDevApp(devRecord)

    // The phone keeps tracking X as a dev build: its record in the dev index,
    // its per-package routing keys, and the dev badge on the projected tile.
    expect(getDevAppRecords().map((record) => record.packageName)).toEqual([packageName])
    expect(JSON.parse(values.get("dev_apps_index") as string)).toEqual([packageName])
    expect(values.get(`${packageName}_dev_url`)).toBe(devRecord.devUrl)
    expect(values.get(`${packageName}_dev_port`)).toBe(devRecord.devPort)
    // Home merges the installed tile with the dev record; the dev build wins.
    const installedTile = {packageName, version: "1.0.0", name: "Installed", running: false}
    const tiles = registry["mergeProjectedApps"]([installedTile]).filter(
      (app: {packageName: string}) => app.packageName === packageName,
    )
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({packageName, isMiniappDev: true, devUrl: devRecord.devUrl})

    // The token request names X itself and carries nothing else.
    const {host, calls} = tokenRequester()
    await host.requestMiniappAuth(packageName)
    await host.requestMiniappAuth(packageName, {minTtlMs: 60_000})
    expect(calls).toEqual([
      [packageName, undefined],
      [packageName, {minTtlMs: 60_000}],
    ])
  })

  test("are refused over a signed install until it is uninstalled", async () => {
    install("1.0.0", {source: "store", publisherKeyFingerprint: "sha256:publisher"})

    const refused = registerDevApp(devRecord)
    await expect(refused).rejects.toBeInstanceOf(SignedMiniappDevBuildError)
    await expect(registerDevApp(devRecord)).rejects.toThrow(
      `${packageName} is installed with a publisher signature. Uninstall it before running a development build.`,
    )
    expect(() => assertDevBuildAllowed(packageName)).toThrow(SignedMiniappDevBuildError)
    expect(values.has(`${packageName}_dev_url`)).toBe(false)
    expect(getDevAppRecords()).toEqual([])

    // Uninstalling clears the recorded signer, so the dev build may run.
    expect((await registry.uninstall(packageName)).is_ok()).toBe(true)
    expect(registry.getPublisherKeyFingerprint(packageName)).toBeNull()
    await registerDevApp(devRecord)
    expect(values.get(`${packageName}_dev_url`)).toBe(devRecord.devUrl)
  })
})

describe("dev snapshots are installs like any other", () => {
  test("an unsigned snapshot cannot replace a signed install", async () => {
    install("1.0.0", {source: "store", publisherKeyFingerprint: "sha256:publisher"})
    const result = await installDevSnapshot()
    expect(result.is_error() && result.error.message).toContain(
      `Unsigned bundle cannot replace signed miniapp ${packageName}`,
    )
    expect(extractions).toBe(0)
  })

  test("a snapshot signed with another key cannot replace a signed install", async () => {
    install("1.0.0", {source: "store", publisherKeyFingerprint: "sha256:publisher"})
    candidateFingerprint = "sha256:laptop"
    const result = await installDevSnapshot()
    expect(result.is_error() && result.error.message).toContain("Publisher signature mismatch")
    expect(extractions).toBe(0)
  })

  test("a snapshot signed with the installed key passes the publisher gate", async () => {
    install("1.0.0", {source: "store", publisherKeyFingerprint: "sha256:publisher"})
    candidateFingerprint = "sha256:publisher"
    await installDevSnapshot()
    expect(extractions).toBe(1)
  })

  test("an unsigned snapshot replaces an unsigned install without pinning it", async () => {
    install("1.0.0", {source: "store"})
    await installDevSnapshot()
    expect(extractions).toBe(1)
    install("dev-1000", {source: "dev_snapshot"})
    expect(registry.getPublisherKeyFingerprint(packageName)).toBeNull()
  })

  test("a signed snapshot pins the package it installs", () => {
    install("dev-1000", {source: "dev_snapshot", publisherKeyFingerprint: "sha256:publisher"})
    expect(registry.getPublisherKeyFingerprint(packageName)).toBe("sha256:publisher")
    expect(() => assertDevBuildAllowed(packageName)).toThrow(SignedMiniappDevBuildError)
  })
})
