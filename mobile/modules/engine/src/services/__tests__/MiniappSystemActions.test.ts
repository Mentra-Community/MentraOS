import {afterEach, beforeEach, describe, expect, it, mock} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  FakeDirectory,
  FakeFile,
  FakePaths,
  crustRealpath,
  fakeExpoFileSystem,
  uriOf,
  useFakeRoots,
} from "./fakeExpoFileSystem"

const shareOpen = mock(async (_options: Record<string, unknown>) => {})
const openURL = mock(async (_url: string) => {})
mock.module("expo-file-system", () => fakeExpoFileSystem)
mock.module("react-native", () => ({Linking: {openURL}}))
mock.module("react-native-share", () => ({default: {open: shareOpen}}))
mock.module("@mentra/miniapp", () => ({MiniappErrorCode: {INVALID_ARGUMENT: "INVALID_ARGUMENT"}}))
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: crustRealpath}}))
const {MiniappSystemActions} = await import("../MiniappSystemActions")

const pkg = "com.example.app"
let root: string
let results: ReturnType<typeof mock>
let actions: InstanceType<typeof MiniappSystemActions>
/** Stands in for the Mentra App's credentials and other private files. */
let credentials: string
let ownDir: string

const lastShare = () => shareOpen.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
const lastResult = () => results.mock.calls.at(-1) as unknown[]
const sharedPath = () => decodeURIComponent(String(lastShare()?.url).replace(/^file:\/\//, ""))
const realCache = () => fs.realpathSync(FakePaths.cache.path)
const expectRefused = () => {
  expect(shareOpen).not.toHaveBeenCalled()
  expect(lastResult()?.[2]).toBe(false)
  expect((lastResult()?.[4] as {code?: string})?.code).toBe("INVALID_ARGUMENT")
}

beforeEach(() => {
  // A /var/... temporary directory resolves to /private/var/..., as an iOS container does.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "system-actions-test-"))
  useFakeRoots(root)
  credentials = path.join(FakePaths.document.path, "mmkv", "mmkv.default")
  fs.mkdirSync(path.dirname(credentials), {recursive: true})
  fs.writeFileSync(credentials, "refresh-token")
  ownDir = path.join(FakePaths.document.path, "mentra_blobs", "partition", pkg)
  fs.mkdirSync(ownDir, {recursive: true})
  shareOpen.mockReset().mockResolvedValue(undefined)
  openURL.mockReset().mockResolvedValue(undefined)
  FakeFile.downloadFileAsync.mockClear()
  results = mock(() => {})
  actions = new MiniappSystemActions({
    sendResult: results,
    ownFilesDirectory: (packageName) => new FakeDirectory(FakePaths.document, "mentra_blobs", "partition", packageName),
  })
})

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true})
})

describe("share", () => {
  it("writes base64 data inside the cache whatever the filename says", async () => {
    for (const filename of ["../document/mmkv/mmkv.default", "/etc/hosts", "..", "a/../../../x"]) {
      await actions.handleShare(pkg, {base64: Buffer.from("miniapp data").toString("base64"), filename}, "r")
      expect(fs.readFileSync(credentials, "utf8")).toBe("refresh-token")
      const shared = fs.realpathSync(sharedPath())
      expect(shared.startsWith(`${realCache()}/`)).toBe(true)
      expect(fs.readFileSync(shared, "utf8")).toBe("miniapp data")
      expect(String(lastShare()?.filename)).not.toContain("/")
      expect(lastResult()?.[3]).toEqual({success: true})
    }
  })

  it("keeps a readable name and gives each share its own file", async () => {
    await actions.handleShare(pkg, {base64: Buffer.from("one").toString("base64"), filename: "notes.txt"}, "a")
    const first = sharedPath()
    await actions.handleShare(pkg, {base64: Buffer.from("two").toString("base64"), filename: "notes.txt"}, "b")
    expect(path.basename(sharedPath())).toBe("notes.txt")
    expect(sharedPath()).not.toBe(first)
    expect(fs.readFileSync(first, "utf8")).toBe("one")
  })

  it("refuses a file URL outside the miniapp's own files", async () => {
    await actions.handleShare(pkg, {url: uriOf(credentials)}, "r")
    expectRefused()
  })

  it("refuses local and unknown schemes in any letter case", async () => {
    for (const url of [
      `FILE://${credentials}`,
      `file://${ownDir}/../../../mmkv/mmkv.default`,
      `file://${ownDir}/%2e%2e/%2e%2e/%2e%2e/mmkv/mmkv.default`,
      "content://com.mentra.mentra.fileprovider/root/mmkv",
      "data:text/plain;base64,QUJD",
      credentials,
      "javascript:alert(1)",
    ]) {
      results.mockClear()
      await actions.handleShare(pkg, {url}, "r")
      expectRefused()
    }
  })

  it("refuses another miniapp's files, even under a similar name", async () => {
    const other = path.join(FakePaths.document.path, "mentra_blobs", "partition", `${pkg}2`)
    fs.mkdirSync(other, {recursive: true})
    fs.writeFileSync(path.join(other, "x.wav"), "other")
    await actions.handleShare(pkg, {url: uriOf(path.join(other, "x.wav"))}, "r")
    expectRefused()
  })

  it("refuses a link inside its own files that leads outside them", async () => {
    fs.symlinkSync(credentials, path.join(ownDir, "link.wav"))
    await actions.handleShare(pkg, {url: uriOf(path.join(ownDir, "link.wav"))}, "r")
    expectRefused()
  })

  it("shares a file from the miniapp's own files", async () => {
    const own = path.join(ownDir, "recording 1.wav")
    fs.writeFileSync(own, "audio")
    await actions.handleShare(pkg, {url: uriOf(own), title: "Recording"}, "r")
    // Shared from a copy in the cache, which Android's share provider can serve.
    expect(fs.realpathSync(sharedPath()).startsWith(`${realCache()}/`)).toBe(true)
    expect(path.basename(sharedPath())).toBe("recording 1.wav")
    expect(fs.readFileSync(sharedPath(), "utf8")).toBe("audio")
    expect(lastShare()?.title).toBe("Recording")
    expect(lastResult()?.[3]).toEqual({success: true})
  })

  it("shares http and https links and plain text as before", async () => {
    await actions.handleShare(pkg, {url: "https://teams.microsoft.com/l/meetup-join/x", title: "Join", text: "Hi"}, "r")
    expect(lastShare()).toEqual({url: "https://teams.microsoft.com/l/meetup-join/x", title: "Join", message: "Hi"})
    await actions.handleShare(pkg, {text: "Meeting notes", title: "Notes"}, "r")
    expect(lastShare()).toEqual({message: "Meeting notes", title: "Notes"})
  })
})

describe("download", () => {
  it("writes base64 data inside the cache whatever the filename says", async () => {
    await actions.handleDownload(
      pkg,
      {base64: Buffer.from("csv").toString("base64"), filename: "../document/mmkv/mmkv.default"},
      "r",
    )
    expect(fs.readFileSync(credentials, "utf8")).toBe("refresh-token")
    const shared = fs.realpathSync(sharedPath())
    expect(shared.startsWith(`${realCache()}/`)).toBe(true)
    expect(fs.readFileSync(shared, "utf8")).toBe("csv")
  })

  it("downloads an https URL into the cache under a safe name", async () => {
    await actions.handleDownload(pkg, {url: "https://example.com/report.pdf", filename: "../../report.pdf"}, "r")
    expect(FakeFile.downloadFileAsync).toHaveBeenCalledTimes(1)
    expect(FakeFile.downloadFileAsync.mock.calls[0]![0]).toBe("https://example.com/report.pdf")
    const shared = fs.realpathSync(sharedPath())
    expect(shared.startsWith(`${realCache()}/`)).toBe(true)
    expect(path.basename(shared)).toBe(".._.._report.pdf")
    expect(fs.readFileSync(shared, "utf8")).toBe("downloaded https://example.com/report.pdf")
  })

  it("refuses to download anything that is not an http or https URL", async () => {
    for (const url of [uriOf(credentials), `FILE://${credentials}`, "content://x/y", "data:,x", credentials]) {
      results.mockClear()
      await actions.handleDownload(pkg, {url, filename: "x.txt"}, "r")
      expect(FakeFile.downloadFileAsync).not.toHaveBeenCalled()
      expectRefused()
    }
  })

  it("answers a request with neither data nor a URL", async () => {
    await actions.handleDownload(pkg, {filename: "x.txt"}, "r")
    expectRefused()
  })
})

describe("open URL", () => {
  it("opens web links and app links", async () => {
    await actions.handleOpenUrl(pkg, {url: "https://example.com"})
    await actions.handleOpenUrl(pkg, {url: "mailto:someone@example.com"})
    expect(openURL.mock.calls.map((c) => c[0])).toEqual(["https://example.com", "mailto:someone@example.com"])
  })

  it("never opens a local file, content URI or script, in any letter case", async () => {
    for (const url of [
      `FILE://${credentials}`,
      ` file://${credentials}`,
      "content://x/y",
      "JavaScript:alert(1)",
      "data:text/html,x",
    ]) {
      await actions.handleOpenUrl(pkg, {url})
    }
    expect(openURL).not.toHaveBeenCalled()
  })

  it("never opens a link to the host app, which would reach its install sheet or sign-in", async () => {
    const isHostLink = mock((url: string) => url.startsWith("com.mentra:") || url.startsWith("https://apps.example/"))
    const hosted = new MiniappSystemActions({
      sendResult: results,
      ownFilesDirectory: (packageName) =>
        new FakeDirectory(FakePaths.document, "mentra_blobs", "partition", packageName),
      isHostLink,
    })
    await hosted.handleOpenUrl(pkg, {url: "com.mentra://open?url=https%3A%2F%2Fnotes.example.com%2F"})
    await hosted.handleOpenUrl(pkg, {url: "https://apps.example/package/com.example.notes"})
    await hosted.handleOpenUrl(pkg, {url: "https://example.com"})
    expect(isHostLink).toHaveBeenCalledTimes(3)
    expect(openURL.mock.calls.map((c) => c[0])).toEqual(["https://example.com"])
  })

  it("refuses a link when the host can't say whether it is its own", async () => {
    const hosted = new MiniappSystemActions({
      sendResult: results,
      ownFilesDirectory: (packageName) =>
        new FakeDirectory(FakePaths.document, "mentra_blobs", "partition", packageName),
      isHostLink: () => {
        throw new Error("not ready")
      },
    })
    await hosted.handleOpenUrl(pkg, {url: "https://example.com"})
    expect(openURL).not.toHaveBeenCalled()
  })
})

describe("media URLs", () => {
  it("allows network and data URLs and the miniapp's own files only", () => {
    const own = path.join(ownDir, "a.wav")
    fs.writeFileSync(own, "audio")
    expect(actions.allowsMediaUrl(pkg, "https://cdn.example.com/a.mp3")).toBe(true)
    expect(actions.allowsMediaUrl(pkg, "data:audio/wav;base64,UklGRg==")).toBe(true)
    expect(actions.allowsMediaUrl(pkg, uriOf(own))).toBe(true)
    expect(actions.allowsMediaUrl(pkg, uriOf(credentials))).toBe(false)
    expect(actions.allowsMediaUrl(pkg, "content://x/y")).toBe(false)
    expect(actions.allowsMediaUrl(pkg, credentials)).toBe(false)
    expect(actions.allowsMediaUrl("com.example.other", uriOf(own))).toBe(false)
  })
})
