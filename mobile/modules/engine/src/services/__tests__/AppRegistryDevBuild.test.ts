import {beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {readFileSync} from "node:fs"
import {result as Res} from "typesafe-ts"

import type {MiniappReleaseIdentity} from "../AppRegistry"

// A development build of a package claims that package's name: the phone applies the
// Android signer rule to it, and Core mints its token marked as a local build's.
;(globalThis as {__DEV__?: boolean}).__DEV__ = false
const values = new Map<string, unknown>()
const installationValues = new Map<string, string>()
let candidateFingerprint: string | undefined
let candidateApiLevel: number | undefined
/** The version directories on disk, by package. */
const onDisk = new Map<string, string[]>()
/** Directories the registry deleted. */
const deleted: string[] = []
let developmentAllowed = true
let installedAllowed = (_identity: MiniappReleaseIdentity | null) => true
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
    getAllKeys: () => [...values.keys()],
  },
}))
mock.module("react-native-mmkv", () => ({
  createMMKV: () => ({
    getString: (key: string) => installationValues.get(key),
    set: (key: string, value: string) => installationValues.set(key, value),
    remove: (key: string) => installationValues.delete(key),
    getAllKeys: () => [...installationValues.keys()],
  }),
}))
mock.module("../../runtime/bootstrap", () => ({
  getConfigValues: () => ({}),
  isDevMiniappAllowed: () => developmentAllowed,
  isLocalMiniappPackageAllowed: () => true,
  isInstalledMiniappAllowed: (_pkg: string, _version: string, identity: MiniappReleaseIdentity | null) =>
    installedAllowed(identity),
  isOfflineSystemMiniappAllowed: () => true,
  isMiniappAvailable: () => true,
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
    uri: string
    constructor(...parts: Array<string | {uri?: string}>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : (part.uri ?? ""))).join("/")
    }
    get name() {
      return this.uri.split("/").at(-1)!
    }
    // Only the earlier app's folder of development icons is there.
    get exists() {
      return this.uri.endsWith("/dev-miniapp-icons")
    }
    create() {}
    delete() {
      deleted.push(this.uri)
    }
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
// Extraction checks each unpacked file's real path through Crust.
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: (path: string) => path}}))
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
    ...(candidateApiLevel ? {minApiLevel: candidateApiLevel} : {}),
  }),
}))

const {default: registry, migrateDevelopmentRecords} = await import("../AppRegistry")
const {isLocalBuildContext, recordMiniappBuild} = await import("../miniappBuildKind")
// The version directories on disk are the test's.
spyOn(registry, "getInstalledVersions").mockImplementation((name: string) => onDisk.get(name) ?? [])

const packageName = "com.example.devbuild"

function install(version: string, identity: MiniappReleaseIdentity) {
  registry["finalizeInstall"](packageName, version, identity, () => {}).apply()
}

function installDevSnapshot() {
  return registry.installFromUrl("http://192.168.1.20:3000/bundle.zip", {
    expectedPackageName: packageName,
    versionOverride: "dev-1000",
    releaseIdentity: {source: "local", sourceUrl: "http://192.168.1.20:3000/"},
  })
}

/** The runtime's real token-request method, run against a recording Cloud Client. */
function tokenRequester() {
  const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
  const start = source.search(/^ {2}private async requestMiniappAuth\(/m)
  if (start < 0) throw new Error("Missing requestMiniappAuth")
  const rest = source.slice(start)
  const method = rest.slice(0, rest.search(/^ {2}}$/m) + 3)
  const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${method} }`)
  const calls: unknown[][] = []
  const cloudClientService = {
    hasCore: () => true,
    getMiniappAuthToken: async (...args: unknown[]) => {
      calls.push(args)
      return {token: "miniapp-token"}
    },
  }
  const Host = new Function("cloudClientService", "isLocalBuildContext", `${compiled}; return Host`)(
    cloudClientService,
    isLocalBuildContext,
  )
  return {host: new Host() as {requestMiniappAuth(pkg: string, opts?: unknown): Promise<unknown>}, calls}
}

beforeEach(() => {
  values.clear()
  installationValues.clear()
  recordMiniappBuild(packageName, {localBuild: false})
  onDisk.clear()
  deleted.length = 0
  candidateFingerprint = undefined
  candidateApiLevel = undefined
  developmentAllowed = true
  installedAllowed = () => true
  extractions = 0
})

test("a snapshot built with a newer Miniapp SDK API level is refused, though its caller names no policy", async () => {
  candidateApiLevel = 1_000
  const installed = await installDevSnapshot()
  expect(installed.is_error() && installed.error.message).toContain("API level")
  expect(extractions).toBe(0)
})

describe("a development build beside an installed release", () => {
  test("runs as the package, marked as a development build, its token marked as a local build's", async () => {
    install("1.0.0", {source: "direct_download"})
    install("dev-1000", {source: "local", sourceUrl: "http://192.168.1.20:3000/"})
    onDisk.set(packageName, ["1.0.0", "dev-1000"])
    expect(registry.isDevelopmentBuild(packageName)).toBe(true)
    expect(await registry.getActiveVersion(packageName)).toBe("dev-1000")
    // Home shows the one tile, the development build's, with its badge.
    const tile = {packageName, version: "dev-1000", name: "Dev Build", running: false, isMiniappDev: true}
    const tiles = registry["mergeProjectedApps"]([tile])
    expect(tiles).toEqual([tile])

    // The router starts X's context as a development build: its token request names X, marked as a local build.
    recordMiniappBuild(packageName, {localBuild: true})
    const {host, calls} = tokenRequester()
    await host.requestMiniappAuth(packageName)
    await host.requestMiniappAuth(packageName, {minTtlMs: 60_000})
    expect(calls).toEqual([
      [packageName, {localBuild: true}],
      [packageName, {minTtlMs: 60_000, localBuild: true}],
    ])
    // Its installed release, started again, asks for the package's own token.
    recordMiniappBuild(packageName, {localBuild: false})
    await host.requestMiniappAuth(packageName)
    expect(calls.at(-1)).toEqual([packageName, undefined])
  })

  test("is the phone's, whichever account or workspace is signed in: nothing hides it", async () => {
    install("dev-1000", {source: "local", sourceUrl: "http://192.168.1.20:3000/"})
    onDisk.set(packageName, ["dev-1000"])
    expect(await registry.getActiveVersion(packageName)).toBe("dev-1000")
    expect(registry.getActiveReleaseVersion(packageName)).toBeNull()
  })

  test("stands in only while the deployment allows development", async () => {
    install("1.0.0", {source: "direct_download"})
    install("dev-1000", {source: "local", sourceUrl: "http://192.168.1.20:3000/"})
    onDisk.set(packageName, ["1.0.0", "dev-1000"])
    developmentAllowed = false
    expect(await registry.getActiveVersion(packageName)).toBe("1.0.0")
    // It still holds the package: only the person replaces it.
    expect(registry.isDevelopmentBuild(packageName)).toBe(true)
  })
})

describe("the migration of development records from an earlier Mentra App", () => {
  const server = "http://192.168.1.20:3000"

  test("a record's newest development build takes its address and console, and every record goes", () => {
    install("dev-1700000000000", {source: "dev_snapshot"})
    install("dev-1800000000000", {source: "dev_snapshot", bundleSha256: "ab".repeat(32)})
    onDisk.set(packageName, ["1.0.0", "dev-1700000000000", "dev-1800000000000"])
    values.set(`${packageName}_dev_url`, server)
    values.set(`${packageName}_dev_port`, 3001)
    values.set(`${packageName}_dev_meta`, JSON.stringify({packageName, devUrl: server}))
    values.set(`${packageName}_dev_selected_snapshot`, "dev-1700000000000")
    values.set("dev_apps_index", JSON.stringify([packageName]))
    values.set("com.example.other_running", true)
    const legacy = () => [...values.keys()].filter((key) => key.includes("_dev_") || key === "dev_apps_index")

    migrateDevelopmentRecords(registry)

    expect(registry.getReleaseIdentity(packageName, "dev-1800000000000")).toEqual({
      source: "local",
      sourceUrl: `${server}/`,
      bundleSha256: "ab".repeat(32),
      reloadUrl: "ws://192.168.1.20:3001/__mentra_dev",
    })
    expect(registry.getReleaseIdentity(packageName, "dev-1700000000000")).toEqual({source: "dev_snapshot"})
    expect(legacy()).toEqual([])
    expect(values.get("com.example.other_running")).toBe(true)
    expect(deleted).toContain("file:///test-documents/dev-miniapp-icons")
  })

  test("runs once: nobody rescans, and a later start finds nothing to do", () => {
    install("dev-1800000000000", {source: "dev_snapshot"})
    onDisk.set(packageName, ["dev-1800000000000"])
    values.set(`${packageName}_dev_url`, server)
    migrateDevelopmentRecords(registry)
    expect(registry.getReleaseIdentity(packageName, "dev-1800000000000")?.sourceUrl).toBe(`${server}/`)

    install("dev-1800000000000", {source: "dev_snapshot"})
    values.set(`${packageName}_dev_url`, "http://192.168.1.99:3000")
    migrateDevelopmentRecords(registry)
    expect(registry.getReleaseIdentity(packageName, "dev-1800000000000")).toEqual({source: "dev_snapshot"})
  })

  test("another account's or workspace's record migrates too, when the live one names none", () => {
    install("dev-1800000000000", {source: "dev_snapshot"})
    onDisk.set(packageName, ["dev-1800000000000"])
    installationValues.set("devsel:ctx.other", JSON.stringify({[`${packageName}_dev_url`]: server}))
    installationValues.set(`devowner:${packageName}:dev-1000`, "ctx.other")
    migrateDevelopmentRecords(registry)
    expect(registry.getReleaseIdentity(packageName, "dev-1800000000000")).toMatchObject({source: "local", sourceUrl: `${server}/`})
    expect([...installationValues.keys()].filter((key) => key.startsWith("devsel") || key.startsWith("devowner"))).toEqual(
      [],
    )
  })

  test("a record whose build is gone, or whose address isn't local, leaves nothing behind", () => {
    values.set(`${packageName}_dev_url`, server)
    values.set("com.example.public_dev_url", "https://example.com")
    install("dev-1800000000000", {source: "dev_snapshot"})
    onDisk.set("com.example.public", ["dev-1800000000000"])
    migrateDevelopmentRecords(registry)
    expect([...values.keys()].filter((key) => key.includes("_dev_"))).toEqual([])
    expect(registry.getReleaseIdentity("com.example.public", "dev-1800000000000")).toBeNull()
  })
})

describe("development builds are installs like any other", () => {
  test("an unsigned snapshot cannot replace a signed install", async () => {
    install("1.0.0", {source: "direct_download", publisherKeyFingerprint: "sha256:publisher"})
    const result = await installDevSnapshot()
    expect(result.is_error() && result.error.message).toContain(
      `Unsigned bundle cannot replace signed miniapp ${packageName}`,
    )
    expect(extractions).toBe(0)
  })

  test("a snapshot signed with another key cannot replace a signed install", async () => {
    install("1.0.0", {source: "direct_download", publisherKeyFingerprint: "sha256:publisher"})
    candidateFingerprint = "sha256:laptop"
    const result = await installDevSnapshot()
    expect(result.is_error() && result.error.message).toContain("Publisher signature mismatch")
    expect(extractions).toBe(0)
  })

  test("a snapshot signed with the installed key passes the publisher gate", async () => {
    install("1.0.0", {source: "direct_download", publisherKeyFingerprint: "sha256:publisher"})
    candidateFingerprint = "sha256:publisher"
    await installDevSnapshot()
    expect(extractions).toBe(1)
  })

  test("an unsigned snapshot replaces an unsigned install without pinning it", async () => {
    install("1.0.0", {source: "direct_download"})
    await installDevSnapshot()
    expect(extractions).toBe(1)
    install("dev-1000", {source: "local", sourceUrl: "http://192.168.1.20:3000/"})
    expect(registry.getPublisherKeyFingerprint(packageName)).toBeNull()
  })

  test("a signed snapshot pins the package it installs", async () => {
    install("dev-1000", {source: "local", publisherKeyFingerprint: "sha256:publisher"})
    expect(registry.getPublisherKeyFingerprint(packageName)).toBe("sha256:publisher")
    // An unsigned build of it is refused from then on.
    const result = await installDevSnapshot()
    expect(result.is_error() && result.error.message).toContain("Unsigned bundle cannot replace signed miniapp")
  })
})

describe("the active version follows the deployment's policy", () => {
  test("the newest allowed release wins once development is off", async () => {
    const workspaceRelease: MiniappReleaseIdentity = {
      source: "deployment_manifest",
      bundleSha256: "abc",
      deploymentId: "acme",
      deploymentOrigin: "https://acme.example",
    }
    install("1.2.0", workspaceRelease)
    install("1.3.0", {source: "direct_download"})
    install("1.4.0", {source: "url", sourceUrl: "https://notes.example.com/"})
    // The workspace allows its managed release, and release-QR installs only while development is on.
    installedAllowed = (identity) =>
      identity?.source === "deployment_manifest" || (developmentAllowed && identity?.source === "direct_download")
    onDisk.set(packageName, ["1.2.0", "1.3.0", "1.4.0"])
    let notified = 0
    const unsubscribe = registry.subscribe(() => notified++)
    try {
      values.set(`${packageName}_active_version`, "1.3.0")
      expect(await registry.getActiveVersion(packageName)).toBe("1.3.0")
      developmentAllowed = false
      expect(await registry.getActiveVersion(packageName)).toBe("1.2.0")
      // Selecting it refreshes cached app lists that still hold the release-QR version.
      expect(values.get(`${packageName}_active_version`)).toBe("1.2.0")
      expect(notified).toBeGreaterThan(0)
    } finally {
      unsubscribe()
    }
  })
})
