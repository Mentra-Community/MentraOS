import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let root: string
let now: number
const GB = 1024 ** 3
const Paths = {cache: "", document: "", availableDiskSpace: 0}
type Part = string | {path: string}
const pathname = (parts: Part[]) =>
  path.join(...parts.map((p) => (typeof p === "string" ? p.replace(/^file:\/\//, "") : p.path)))
class Directory {
  path: string
  constructor(...parts: Part[]) {
    this.path = pathname(parts)
  }
  get exists() {
    return fs.existsSync(this.path)
  }
  create() {
    fs.mkdirSync(this.path, {recursive: true})
  }
  delete() {
    fs.rmSync(this.path, {recursive: true})
  }
}
class File {
  path: string
  constructor(...parts: Part[]) {
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
  get md5() {
    return "md5"
  }
  move(target: File) {
    fs.renameSync(this.path, target.path)
    this.path = target.path
  }
  rename(name: string) {
    this.move(new File(path.dirname(this.path), name))
  }
  copy(target: File) {
    fs.copyFileSync(this.path, target.path)
  }
  delete() {
    fs.unlinkSync(this.path)
  }
  async base64() {
    return fs.readFileSync(this.path).toString("base64")
  }
  create() {
    fs.mkdirSync(path.dirname(this.path), {recursive: true})
    fs.writeFileSync(this.path, "")
  }
  /** A handle that appends: all these tests write. */
  open() {
    const file = this.path
    return {
      offset: 0,
      writeBytes: (bytes: Uint8Array) => fs.appendFileSync(file, bytes),
      close: () => {},
    }
  }
}
const values = new Map<string, unknown>()
const ok = (value: unknown) => ({is_ok: () => true, is_error: () => false, value})
const missing = {is_ok: () => false, is_error: () => true}
mock.module("expo-file-system", () => ({Directory, File, Paths}))
const uploads: Array<{url: string; body: string; method?: string}> = []
mock.module("expo-file-system/legacy", () => ({
  FileSystemUploadType: {BINARY_CONTENT: 0},
  uploadAsync: async (url: string, uri: string, options: {httpMethod?: string}) => {
    uploads.push({url, body: fs.readFileSync(uri.replace(/^file:\/\//, ""), "utf8"), method: options.httpMethod})
    return {status: url.includes("refused") ? 403 : 200}
  },
}))
/** What the document picker answers next: a file it copied into the cache, or a cancel. */
let picked:
  | {canceled: true}
  | {canceled: false; assets: Array<{uri: string; name: string; mimeType?: string; size?: number}>} = {canceled: true}
const pickerTypes: unknown[] = []
mock.module("expo-document-picker", () => ({
  getDocumentAsync: async (options: {type?: unknown}) => (pickerTypes.push(options.type), picked),
}))
mock.module("react-native-share", () => ({default: {open: async () => {}}}))
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: () => null}}))
mock.module("@mentra/miniapp", () => ({
  MiniappErrorCode: new Proxy({}, {get: (_target, code) => code}),
}))
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) => (values.has(key) ? ok(values.get(key)) : missing),
    save: (key: string, value: unknown) => (values.set(key, value), ok(undefined)),
    remove: (key: string) => (values.delete(key), ok(undefined)),
    getAllKeys: () => [...values.keys()],
  },
}))
const {BlobStore, BLOB_MIN_QUOTA_BYTES} = await import("../BlobStore")

const pkg = "com.acme.camera"
let partition = "core.mu_1.p"
let clock: ReturnType<typeof spyOn>
let results: Array<{ok: boolean; result?: unknown; error?: {code?: string}}>
let store: InstanceType<typeof BlobStore>
let photos = 0

/** A photo the native layer left in the cache folder, as a file:// URI. */
function nativePhoto(bytes = 1000): string {
  const file = path.join(Paths.cache, `photo_${++photos}.jpg`)
  fs.writeFileSync(file, Buffer.alloc(bytes, 7))
  return `file://${file}`
}
const take = (key: string, bytes?: number, app = pkg) =>
  store.storeCachedFile(app, key, nativePhoto(bytes), "image/jpeg")
const last = () => results.at(-1)!
const get = (key: string, app = pkg) => (store.handleGet(app, {key}), last().result as {uri: string} | null)
const list = () => (store.handleList(pkg, {}), (last().result as {blobs: Array<{key: string}>}).blobs.map((b) => b.key))
const onDisk = (uri: string) => fs.existsSync(uri.replace(/^file:\/\//, ""))
/** What blob.set does on the host: a streamed write under the miniapp's key. */
const write = (key: string, bytes: number, cache?: boolean) => {
  store.handleCreate(pkg, {key, mimeType: "image/jpeg", ...(cache ? {cache} : {})})
  store.handleWrite(pkg, {key, base64: Buffer.alloc(bytes, 7).toString("base64")})
  if (!last().ok) return last()
  store.handleCommit(pkg, {key})
  return last()
}
const usage = () => (store.handleUsage(pkg, {}), last().result as {bytes: number; count: number; quotaBytes: number})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blob-cache-test-"))
  Paths.cache = path.join(root, "cache")
  Paths.document = path.join(root, "documents")
  fs.mkdirSync(Paths.cache)
  fs.mkdirSync(Paths.document)
  Paths.availableDiskSpace = GB
  values.clear()
  partition = "core.mu_1.p"
  now = 1_800_000_000_000
  clock = spyOn(Date, "now").mockImplementation(() => now)
  results = []
  store = new BlobStore({
    sendResult: (_pkg, _requestId, ok, result, error) => results.push({ok, result, error}),
    getPartition: () => ({id: partition, personalUserId: null}),
  })
})
afterEach(() => {
  clock.mockRestore()
  fs.rmSync(root, {recursive: true})
})

describe("importing a picked file", () => {
  it("keeps the picker's cache copy under the key, with the file's own name; a cancel resolves to null", async () => {
    const copy = path.join(Paths.cache, "DocumentPicker", "a1b2.xlsx")
    fs.mkdirSync(path.dirname(copy), {recursive: true})
    fs.writeFileSync(copy, Buffer.alloc(300, 1))
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    picked = {
      canceled: false,
      assets: [{uri: `file://${copy}`, name: "dvi-inspection.xlsx", mimeType: xlsx, size: 300}],
    }
    await store.handleImport(pkg, {key: "forms/m1", mimeType: ["application/pdf", xlsx]})
    expect(last().result).toMatchObject({key: "forms/m1", name: "dvi-inspection.xlsx", mimeType: xlsx, bytes: 300})
    expect(pickerTypes.at(-1)).toEqual(["application/pdf", xlsx])
    // The cache copy became the blob.
    expect(fs.existsSync(copy)).toBe(false)
    picked = {canceled: true}
    await store.handleImport(pkg, {key: "forms/m2"})
    expect(last()).toMatchObject({ok: true, result: null})
    expect(pickerTypes.at(-1)).toBe("*/*")
  })
})

describe("cached blobs", () => {
  it("moves the host's file into a cached blob, readable under its key", () => {
    const source = nativePhoto(1234)
    const meta = store.storeCachedFile(pkg, "photo/p1", source, "image/jpeg")
    expect(meta).toMatchObject({key: "photo/p1", mimeType: "image/jpeg", bytes: 1234, cached: true})
    expect(onDisk(source)).toBe(false)
    expect(meta.uri).toEndWith(".jpg")
    store.handleOpenRead(pkg, {key: "photo/p1"})
    expect(last().ok).toBe(true)
  })

  it("names the URL the package's screen loads each file from", async () => {
    const {recordMiniappScreenOrigin, resetMiniappScreenOriginsForTests} = await import("../miniappScreenOrigin")
    expect(take("photo/p0")).not.toHaveProperty("url")
    recordMiniappScreenOrigin(pkg, "miniapp://com.acme.camera")
    const photo = take("photo/p1")
    const fileName = photo.uri.slice(photo.uri.lastIndexOf("/") + 1)
    expect(photo.url).toBe(`miniapp://com.acme.camera/.mentra/files/${fileName}`)
    expect(get("photo/p1")).toMatchObject({url: photo.url})
    resetMiniappScreenOriginsForTests()
  })

  it("uploads a file from disk, and fails on a refused answer", async () => {
    fs.writeFileSync(path.join(Paths.cache, "note.txt"), "hello")
    store.storeCachedFile(pkg, "note", `file://${path.join(Paths.cache, "note.txt")}`, "text/plain")
    await store.handleUpload(pkg, {key: "note", url: "https://store.example/put"})
    expect(last()).toMatchObject({ok: true, result: {status: 200}})
    expect(uploads.at(-1)).toEqual({url: "https://store.example/put", body: "hello", method: "PUT"})
    await store.handleUpload(pkg, {key: "note", url: "https://store.example/refused"})
    expect(last()).toMatchObject({ok: false, error: {code: "BLOB_UPLOAD_FAILED"}})
  })

  it("a cached write succeeds with the quota full, and usage leaves it out", () => {
    Paths.availableDiskSpace = 100_000
    expect(write("permanent", 200_000)).toMatchObject({ok: false, error: {code: "BLOB_QUOTA_EXCEEDED"}})
    expect(write("cached", 20_000, true)).toMatchObject({ok: true, result: {cached: true}})
    expect(usage()).toMatchObject({bytes: 0, count: 0})
  })

  it("over its budget, the least recently read goes first, and is then simply absent", () => {
    // Budget: a quarter of (cached bytes + free space) = (6000 + 12000) / 4 = 4500 once three are cached.
    Paths.availableDiskSpace = 12_000
    take("photo/a", 2000)
    now += 1000
    const b = take("photo/b", 2000)
    now += 1000
    expect(get("photo/a")).not.toBeNull()
    now += 1000
    take("photo/c", 2000)
    expect(list()).toEqual(["photo/c", "photo/a"])
    expect(onDisk(b.uri)).toBe(false)
    expect(get("photo/b")).toBeNull()
  })

  it("the blob just written always stays, whatever its size, even written in the same millisecond as another", () => {
    Paths.availableDiskSpace = 0
    take("photo/huge", 10_000)
    expect(list()).toEqual(["photo/huge"])
    take("photo/small", 10)
    expect(list()).toEqual(["photo/small"])
  })

  it("setCached moves a blob out of the quota and back, failing when it doesn't fit", () => {
    write("report.pdf", 3000)
    store.handleSetCached(pkg, {key: "report.pdf", cached: true})
    expect(last()).toMatchObject({ok: true, result: {cached: true}})
    expect(usage()).toMatchObject({bytes: 0, count: 0})
    store.handleSetCached(pkg, {key: "report.pdf", cached: false})
    expect(last().result).not.toHaveProperty("cached")
    expect(usage()).toMatchObject({bytes: 3000, count: 1})
    store.handleSetCached(pkg, {key: "report.pdf", cached: true})
    Paths.availableDiskSpace = 1000
    store.handleSetCached(pkg, {key: "report.pdf", cached: false})
    expect(last()).toMatchObject({ok: false, error: {code: "BLOB_QUOTA_EXCEEDED"}})
    store.handleSetCached(pkg, {key: "gone", cached: true})
    expect(last()).toMatchObject({ok: false, error: {code: "BLOB_NOT_FOUND"}})
  })

  it("the quota is half of what the app stores plus the phone's free space, never below 1 GB unless the phone has less room", () => {
    take("photo/p1", 2000)
    store.handleCopy(pkg, {from: "photo/p1", key: "kept"})
    Paths.availableDiskSpace = 8 * GB
    expect(usage()).toMatchObject({bytes: 2000, quotaBytes: 4 * GB + 1000})
    Paths.availableDiskSpace = GB
    expect(usage()).toMatchObject({quotaBytes: BLOB_MIN_QUOTA_BYTES})
    Paths.availableDiskSpace = 100_000
    expect(usage()).toMatchObject({quotaBytes: 102_000})
  })

  it("copies a photo under the miniapp's own key: permanent unless asked to cache", () => {
    const photo = take("photo/p1", 3000)
    store.handleCopy(pkg, {from: "photo/p1", key: "photos/kept.jpg"})
    expect(last()).toMatchObject({ok: true, result: {key: "photos/kept.jpg", mimeType: "image/jpeg", bytes: 3000}})
    const copy = last().result as {uri: string}
    expect(copy).not.toHaveProperty("cached")
    expect(copy.uri).not.toBe(photo.uri)
    expect(usage()).toMatchObject({bytes: 3000, count: 1})
    store.handleCopy(pkg, {from: "photo/p1", key: "photos/also.jpg", cache: true})
    expect(last()).toMatchObject({ok: true, result: {cached: true}})
    store.handleCopy(pkg, {from: "photo/none", key: "again"})
    expect(last()).toMatchObject({ok: false, error: {code: "BLOB_NOT_FOUND"}})
  })
})
