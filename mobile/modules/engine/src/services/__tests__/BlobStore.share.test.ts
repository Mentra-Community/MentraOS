import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let root: string
let now: number
let copies: number
let failCopy: boolean
const Paths = {cache: "", document: ""}
const shareOpen = mock(async (_options: {url: string}) => {})
const pathname = (parts: Array<string | {uri: string}>) =>
  path.join(...parts.map((p) => (typeof p === "string" ? p : p.uri)))
const touch = (name: string) => fs.utimesSync(name, now / 1000, now / 1000)
class Directory {
  uri: string
  constructor(...parts: Array<string | {uri: string}>) {
    this.uri = pathname(parts)
  }
  get name() {
    return path.basename(this.uri)
  }
  get exists() {
    return fs.existsSync(this.uri)
  }
  create() {
    fs.mkdirSync(this.uri, {recursive: true})
    touch(this.uri)
  }
  list() {
    return fs
      .readdirSync(this.uri)
      .map((name) =>
        fs.statSync(path.join(this.uri, name)).isDirectory() ? new Directory(this, name) : new File(this, name),
      )
  }
  info() {
    return {modificationTime: fs.statSync(this.uri).mtimeMs}
  }
  delete() {
    fs.rmSync(this.uri, {recursive: true})
  }
}
class File {
  uri: string
  constructor(...parts: Array<string | {uri: string}>) {
    this.uri = pathname(parts)
  }
  get exists() {
    return fs.existsSync(this.uri)
  }
  get size() {
    return fs.statSync(this.uri).size
  }
  copy(target: File) {
    if (failCopy) throw new Error("copy failed")
    copies++
    fs.copyFileSync(this.uri, target.uri)
    touch(path.dirname(target.uri))
  }
  write(value: string) {
    fs.writeFileSync(this.uri, value)
  }
  textSync() {
    return fs.readFileSync(this.uri, "utf8")
  }
  delete() {
    fs.unlinkSync(this.uri)
  }
}
mock.module("expo-file-system", () => ({Directory, File, Paths}))
mock.module("react-native-share", () => ({default: {open: shareOpen}}))
mock.module("@mentra/miniapp", () => ({MiniappErrorCode: {BLOB_NOT_FOUND: "BLOB_NOT_FOUND"}}))
mock.module("../../utils/storage/storage", () => ({storage: {}}))
const {BlobStore} = await import("../BlobStore")

const DAY = 24 * 60 * 60 * 1000
const bytes = Buffer.from("RIFF retained recording bytes")
let clock: ReturnType<typeof spyOn>
let store: InstanceType<typeof BlobStore>
let results: ReturnType<typeof mock>
const share = (key = "a") => store.handleShare("recorder", {key})
const lastUrl = () => shareOpen.mock.calls.at(-1)![0].url
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
  store = new BlobStore({sendResult: results, getUserId: () => "user"})
  const source = new File(Paths.document, "recording.wav")
  fs.writeFileSync(source.uri, bytes)
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
