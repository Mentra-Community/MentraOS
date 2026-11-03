import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {crustRealpath} from "./fakeExpoFileSystem"

let root: string
let now: number
let copies: number
let failCopy: boolean
const Paths = {cache: "", document: ""}
const shareOpen = mock(async (_options: {url: string}) => {})
// Like expo-file-system: parts joined with a normalizing join, `file://` URIs.
const pathname = (parts: Array<string | {path: string}>) =>
  path.join(...parts.map((p) => (typeof p === "string" ? p : p.path)))
const touch = (name: string) => fs.utimesSync(name, now / 1000, now / 1000)
class Directory {
  path: string
  constructor(...parts: Array<string | {path: string}>) {
    this.path = pathname(parts)
  }
  get uri() {
    return `file://${this.path}/`
  }
  get name() {
    return path.basename(this.path)
  }
  get exists() {
    return fs.existsSync(this.path)
  }
  create() {
    fs.mkdirSync(this.path, {recursive: true})
    touch(this.path)
  }
  list() {
    return fs
      .readdirSync(this.path)
      .map((name) =>
        fs.statSync(path.join(this.path, name)).isDirectory() ? new Directory(this, name) : new File(this, name),
      )
  }
  info() {
    return {modificationTime: fs.statSync(this.path).mtimeMs}
  }
  delete() {
    fs.rmSync(this.path, {recursive: true})
  }
}
class File {
  path: string
  constructor(...parts: Array<string | {path: string}>) {
    this.path = pathname(parts)
  }
  get uri() {
    return `file://${this.path}`
  }
  get exists() {
    return fs.existsSync(this.path)
  }
  get size() {
    return fs.statSync(this.path).size
  }
  copy(target: File) {
    if (failCopy) throw new Error("copy failed")
    copies++
    fs.copyFileSync(this.path, target.path)
    touch(path.dirname(target.path))
  }
  write(value: string) {
    fs.writeFileSync(this.path, value)
  }
  textSync() {
    return fs.readFileSync(this.path, "utf8")
  }
  delete() {
    fs.unlinkSync(this.path)
  }
  static downloadFileAsync = mock(async (_url: string, target: File) => target)
}
mock.module("expo-file-system", () => ({Directory, File, Paths}))
mock.module("react-native-share", () => ({default: {open: shareOpen}}))
mock.module("@mentra/miniapp", () => ({MiniappErrorCode: {BLOB_NOT_FOUND: "BLOB_NOT_FOUND"}}))
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: crustRealpath}}))
mock.module("../../utils/storage/storage", () => ({storage: {}}))
const {BlobStore} = await import("../BlobStore")

const DAY = 24 * 60 * 60 * 1000
const bytes = Buffer.from("RIFF retained recording bytes")
let clock: ReturnType<typeof spyOn>
let store: InstanceType<typeof BlobStore>
let results: ReturnType<typeof mock>
const share = (key = "a") => store.handleShare("recorder", {key})
const lastUrl = () => shareOpen.mock.calls.at(-1)![0].url.replace(/^file:\/\//, "")
const readable = (url: string) => fs.existsSync(url) && fs.readFileSync(url).equals(bytes)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blob-share-test-"))
  Paths.cache = path.join(root, "cache")
  Paths.document = path.join(root, "documents")
  fs.mkdirSync(Paths.cache)
  fs.mkdirSync(Paths.document)
  now = 1800000000000
  copies = 0
  failCopy = false
  clock = spyOn(Date, "now").mockImplementation(() => now)
  shareOpen.mockReset().mockResolvedValue(undefined)
  results = mock(() => {})
  store = new BlobStore({sendResult: results, getPartition: () => ({id: "user", personalUserId: null})})
  const source = new File(Paths.document, "recording.wav")
  fs.writeFileSync(source.path, bytes)
  Object.assign(store, {
    readMeta: (_pkg: string, key: string) => ({
      key,
      fileName: `mywpiww0-${key}.wav`,
      name: "Recording.wav",
      mimeType: "audio/wav",
      bytes: bytes.length,
    }),
    fileFor: () => source,
  })
})
afterEach(() => {
  clock.mockRestore()
  fs.rmSync(root, {recursive: true})
})

describe("blob share lifetime", () => {
  it("keeps identical bytes for a delayed reader after handoff", async () => {
    await share()
    expect(readable(lastUrl())).toBe(true)
  })
  it("reuses cache bytes while renewing retention on every share", async () => {
    await share()
    const url = lastUrl()
    now += DAY - 1000
    await share()
    expect(lastUrl()).toBe(url)
    expect(copies).toBe(1)
    now += 2000
    await share("b")
    expect(readable(url)).toBe(true)
  })
  it("keeps ambiguous cancellations but removes failed preparation", async () => {
    shareOpen.mockRejectedValueOnce(new Error("User did not share"))
    await share()
    expect(readable(lastUrl())).toBe(true)
    expect(results.mock.calls.at(-1)?.[3]).toEqual({success: false, cancelled: true})
    failCopy = true
    await share("failed")
    expect(fs.existsSync(path.join(Paths.cache, "mentra_blob_share", "mywpiww0-failed.wav"))).toBe(false)
  })
  it("prunes expired copies on a later share", async () => {
    await share()
    const url = lastUrl()
    now += DAY + 1
    await share("b")
    expect(fs.existsSync(url)).toBe(false)
  })
  it("protects concurrent shares until the last chooser finishes", async () => {
    let finishFirst!: () => void
    let finishSecond!: () => void
    shareOpen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        }),
    )
    shareOpen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve
        }),
    )
    const first = share()
    const url = lastUrl()
    const second = share()
    finishFirst()
    await first
    now += DAY + 1
    await share("b")
    expect(readable(url)).toBe(true)
    finishSecond()
    await second
    now += 1000
    await share("c")
    expect(readable(url)).toBe(true)
  })
})

describe("blob setFromUrl", () => {
  it("downloads only http and https URLs, whatever their letter case", async () => {
    for (const url of [
      "FILE:///var/mobile/Containers/Data/Application/X/Documents/mmkv/mmkv.default",
      " file:///etc/hosts",
      "content://com.mentra.mentra.fileprovider/root/x",
      "data:text/plain,x",
      "/etc/hosts",
    ]) {
      results.mockClear()
      await store.handleSetFromUrl("recorder", {key: "k", url}, "r")
      expect(results.mock.calls.at(-1)?.[2]).toBe(false)
      expect(results.mock.calls.at(-1)?.[4]?.message).toContain("Unsupported URL scheme")
    }
    expect(File.downloadFileAsync).not.toHaveBeenCalled()
  })
})
