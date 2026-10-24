import {afterAll, beforeEach, describe, expect, mock, test} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {result as Res} from "typesafe-ts"

import {FakePaths, crustRealpath, fakeExpoFileSystem, pathOf, useFakeRoots} from "./fakeExpoFileSystem"

// The ZIP validator refuses entries marked as links, but the native unzipper decides what it writes (iOS's can write
// links). Whatever it wrote, an install that finds a link among the unpacked files refuses before reading them.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-registry-links-"))
useFakeRoots(root)
const secret = path.join(root, "refresh-token")
fs.writeFileSync(secret, "the Mentra App's own file")

const values = new Map<string, unknown>()
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
const installationValues = new Map<string, string>()
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
mock.module("expo/fetch", () => ({fetch: mock()}))
mock.module("expo-file-system", () => fakeExpoFileSystem)
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: crustRealpath}}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))

/** What the native unzipper writes into the target directory. */
let unpack: (target: string) => void
mock.module("react-native-zip-archive", () => ({
  unzip: async (_zip: string, target: string) => {
    unpack(pathOf(target))
    return target
  },
}))
const packageName = "com.acme.tools"
const realValidation = await import("../validateInstallBundle")
mock.module("../validateInstallBundle", () => ({
  ...realValidation,
  validateInstallBundleArchive: async () => ({packageName, version: "1.0.0"}),
}))

const {default: registry} = await import("../AppRegistry")

function writeBundle(target: string): void {
  fs.mkdirSync(path.join(target, "ui"), {recursive: true})
  fs.writeFileSync(path.join(target, "miniapp.json"), JSON.stringify({packageName, version: "1.0.0"}))
  fs.writeFileSync(path.join(target, "ui", "index.html"), "<html>")
}

function install() {
  return registry.installFromUrl("https://tools.acme.com/com.acme.tools-1.0.0.zip", {
    expectedPackageName: packageName,
    expectedVersion: "1.0.0",
    downloadBundle: async () => Uint8Array.from([1, 2, 3]),
  })
}

const unzipDirectories = () => fs.readdirSync(FakePaths.cache.path).filter((name) => name.startsWith("lma_unzip-"))
const installedPackages = () => {
  const lmas = path.join(FakePaths.document.path, "lmas")
  return fs.existsSync(lmas) ? fs.readdirSync(path.join(lmas)) : []
}

beforeEach(() => {
  values.clear()
  installationValues.clear()
  fs.rmSync(path.join(FakePaths.document.path, "lmas"), {recursive: true, force: true})
})

afterAll(() => {
  fs.rmSync(root, {recursive: true, force: true})
})

describe("an unpacked bundle with a link in it", () => {
  test.each([
    [
      "a file linked to one of the app's own",
      "ui/data.json",
      (t: string) => fs.symlinkSync(secret, path.join(t, "ui", "data.json")),
    ],
    [
      "miniapp.json itself",
      "miniapp.json",
      (t: string) => {
        fs.rmSync(path.join(t, "miniapp.json"))
        fs.symlinkSync(secret, path.join(t, "miniapp.json"))
      },
    ],
    [
      "a linked directory",
      "ui/docs",
      (t: string) => fs.symlinkSync(FakePaths.document.path, path.join(t, "ui", "docs")),
    ],
    [
      "a link within the bundle",
      "ui/again.html",
      (t: string) => fs.symlinkSync(path.join(t, "ui", "index.html"), path.join(t, "ui", "again.html")),
    ],
  ])("%s is refused before anything reads it, and nothing installs", async (_name, linked, addLink) => {
    unpack = (target) => {
      writeBundle(target)
      addLink(target)
    }
    const result = await install()
    expect(result.is_error() && result.error.message).toBe(`bundle contains a symbolic link: ${linked}`)
    expect(installedPackages()).toEqual([])
    expect(unzipDirectories()).toEqual([])
    expect(fs.readFileSync(secret, "utf8")).toBe("the Mentra App's own file")
  })

  test("a bundle of plain files gets past the check", async () => {
    unpack = writeBundle
    const result = await install()
    // Past the check and the manifest, it stops moving files into place: the fake file system has no moves.
    expect(result.is_error() && result.error.message).toBe("INSTALL_CONTENTS_FAILED")
  })
})
