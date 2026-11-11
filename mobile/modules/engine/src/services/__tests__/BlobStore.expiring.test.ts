import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let root: string
let now: number
const Paths = {cache: "", document: ""}
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
const {BlobStore, BLOB_QUOTA_BYTES, EXPIRING_BLOB_MAX_BYTES, EXPIRING_BLOB_MAX_COUNT, EXPIRING_BLOB_TTL_MS} =
  await import("../BlobStore")

const pkg = "com.acme.camera"
const MINUTE = 60 * 1000
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
  store.storeExpiringFile(app, key, nativePhoto(bytes), "image/jpeg")
const last = () => results.at(-1)!
const get = (key: string, app = pkg) => (store.handleGet(app, {key}), last().result as {uri: string} | null)
const list = () => (store.handleList(pkg, {}), (last().result as {blobs: Array<{key: string}>}).blobs.map((b) => b.key))
const onDisk = (uri: string) => fs.existsSync(uri.replace(/^file:\/\//, ""))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blob-expiring-test-"))
  Paths.cache = path.join(root, "cache")
  Paths.document = path.join(root, "documents")
  fs.mkdirSync(Paths.cache)
  fs.mkdirSync(Paths.document)
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

describe("expiring blobs", () => {
  it("moves the host's file into the miniapp's blobs, readable under its key until it expires", () => {
    const source = nativePhoto(1234)
    const meta = store.storeExpiringFile(pkg, "photo/p1", source, "image/jpeg")
    expect(meta).toMatchObject({
      key: "photo/p1",
      mimeType: "image/jpeg",
      bytes: 1234,
      expiresAt: now + EXPIRING_BLOB_TTL_MS,
    })
    expect(onDisk(source)).toBe(false)
    expect(meta.uri).toEndWith(".jpg")
    expect(fs.statSync(meta.uri.replace(/^file:\/\//, "")).size).toBe(1234)
    store.handleOpenRead(pkg, {key: "photo/p1"})
    expect(last().ok).toBe(true)

    now += EXPIRING_BLOB_TTL_MS - 1
    expect(get("photo/p1")).not.toBeNull()
    now += 1
    expect(get("photo/p1")).toBeNull()
    expect(onDisk(meta.uri)).toBe(false)
    store.handleOpenRead(pkg, {key: "photo/p1"})
    expect(last()).toMatchObject({ok: false, error: {code: "BLOB_NOT_FOUND"}})
  })

  it("stays outside the quota", () => {
    take("photo/p1", 5000)
    store.handleUsage(pkg, {})
    expect(last().result).toEqual({bytes: 0, count: 0, quotaBytes: BLOB_QUOTA_BYTES})
    expect(list()).toEqual(["photo/p1"])
    // Expiry must not push the cached usage below what the miniapp really stores.
    now += EXPIRING_BLOB_TTL_MS
    expect(list()).toEqual([])
    store.handleUsage(pkg, {})
    expect(last().result).toMatchObject({bytes: 0, count: 0})
  })

  it("keeps an app's newest photos within the count limit", () => {
    const first = take("photo/p0")
    for (let i = 1; i <= EXPIRING_BLOB_MAX_COUNT; i++) {
      now += 1000
      take(`photo/p${i}`)
    }
    expect(get("photo/p0")).toBeNull()
    expect(onDisk(first.uri)).toBe(false)
    expect(get("photo/p1")).not.toBeNull()
    expect(list()).toHaveLength(EXPIRING_BLOB_MAX_COUNT)
  })

  it("keeps an app's newest photos within the size limit, and always the newest", () => {
    const third = Math.floor(EXPIRING_BLOB_MAX_BYTES / 3)
    take("photo/a", third)
    now += 1000
    take("photo/b", third)
    now += 1000
    take("photo/c", third + 10)
    now += 1000
    expect(list()).toEqual(["photo/c", "photo/b"])
    take("photo/huge", EXPIRING_BLOB_MAX_BYTES + 1)
    expect(list()).toEqual(["photo/huge"])
  })

  it("a copy the miniapp keeps under its own key doesn't expire and counts toward the quota", () => {
    take("photo/p1", 2000)
    // What blob.set does on the host: a streamed upload under the miniapp's key.
    store.handleCreate(pkg, {key: "receipt", mimeType: "image/jpeg"})
    store.handleWrite(pkg, {key: "receipt", base64: Buffer.alloc(2000, 7).toString("base64")})
    store.handleCommit(pkg, {key: "receipt"})
    expect(last().ok).toBe(true)
    now += EXPIRING_BLOB_TTL_MS * 2
    expect(list()).toEqual(["receipt"])
    store.handleUsage(pkg, {})
    expect(last().result).toMatchObject({bytes: 2000, count: 1})
  })

  it("gives a small blob as a data: URL, for a screen no origin can serve it to", async () => {
    take("photo/p1", 4)
    expect(await store.dataUrlOf(pkg, "photo/p1", 1000)).toBe("data:image/jpeg;base64,BwcHBw==")
    expect(await store.dataUrlOf(pkg, "photo/p1", 3)).toBeNull()
    expect(await store.dataUrlOf(pkg, "photo/missing", 1000)).toBeNull()
    now += EXPIRING_BLOB_TTL_MS
    expect(await store.dataUrlOf(pkg, "photo/p1", 1000)).toBeNull()
  })

  it("the first photo of a host run deletes every app's expired photos, in every partition", () => {
    const mine = take("photo/old")
    const theirs = take("photo/old", 1000, "com.other.app")
    partition = "core.mu_2.p"
    const otherAccount = take("photo/old")
    now += 10 * MINUTE
    const stillFresh = take("photo/fresh", 1000, "com.other.app")
    now += EXPIRING_BLOB_TTL_MS - 5 * MINUTE

    // A new host run: nothing has looked at those apps since.
    partition = "core.mu_1.p"
    store = new BlobStore({sendResult: () => {}, getPartition: () => ({id: partition, personalUserId: null})})
    take("photo/new")
    expect([mine, theirs, otherAccount].map((m) => onDisk(m.uri))).toEqual([false, false, false])
    expect(onDisk(stillFresh.uri)).toBe(true)
    expect([...values.keys()].sort()).toEqual([
      "mentraos_blobmeta/core.mu_1.p/com.acme.camera/photo/new",
      "mentraos_blobmeta/core.mu_2.p/com.other.app/photo/fresh",
    ])
  })
})
