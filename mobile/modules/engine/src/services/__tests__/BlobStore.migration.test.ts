import {afterEach, beforeEach, describe, expect, it, mock} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let root: string
let failMove: boolean
const Paths = {cache: "", document: ""}
const pathname = (parts: Array<string | {uri: string}>) =>
  path.join(...parts.map((p) => (typeof p === "string" ? p : p.uri)))
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
  }
  list() {
    return fs
      .readdirSync(this.uri)
      .map((name) =>
        fs.statSync(path.join(this.uri, name)).isDirectory() ? new Directory(this, name) : new File(this, name),
      )
  }
  move(target: Directory) {
    if (failMove) throw new Error("move failed")
    fs.renameSync(this.uri, target.uri)
    this.uri = target.uri
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
  get name() {
    return path.basename(this.uri)
  }
  get exists() {
    return fs.existsSync(this.uri)
  }
  move(target: Directory | File) {
    if (failMove) throw new Error("move failed")
    const to = target instanceof Directory ? path.join(target.uri, this.name) : target.uri
    fs.renameSync(this.uri, to)
    this.uri = to
  }
}
const values = new Map<string, unknown>()
const ok = (value: unknown) => ({is_ok: () => true, is_error: () => false, value})
const missing = {is_ok: () => false, is_error: () => true}
mock.module("expo-file-system", () => ({Directory, File, Paths}))
mock.module("react-native-share", () => ({default: {open: async () => {}}}))
mock.module("@mentra/miniapp", () => ({MiniappErrorCode: {BLOB_NOT_FOUND: "BLOB_NOT_FOUND"}}))
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) => (values.has(key) ? ok(values.get(key)) : missing),
    save: (key: string, value: unknown) => (values.set(key, value), ok(undefined)),
    remove: (key: string) => (values.delete(key), ok(undefined)),
    getAllKeys: () => [...values.keys()],
  },
}))
const {BlobStore} = await import("../BlobStore")

const pkg = "com.acme.recorder"
const fileName = "mywpiww0-take.wav"
const partition = {id: "core.mu_5f1.p", personalUserId: "mu_1"}
let results: Array<{ok: boolean; result: unknown}>
let store: InstanceType<typeof BlobStore>
const legacyFile = () => path.join(Paths.document, "mentra_blobs", "mu_1", pkg, fileName)
const targetDir = () => path.join(Paths.document, "mentra_blobs", partition.id, pkg)
const get = () => {
  store.handleGet(pkg, {key: "take"})
  return results.at(-1)!
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blob-migration-test-"))
  Paths.document = path.join(root, "documents")
  fs.mkdirSync(path.dirname(legacyFile()), {recursive: true})
  fs.writeFileSync(legacyFile(), "take bytes")
  values.clear()
  values.set(`mentraos_blobmeta_mu_1_${pkg}_take`, {key: "take", fileName, mimeType: "audio/wav", bytes: 10})
  failMove = false
  results = []
  store = new BlobStore({
    sendResult: (_pkg, _id, success, result) => results.push({ok: success, result}),
    getPartition: () => partition,
  })
})
afterEach(() => fs.rmSync(root, {recursive: true}))

describe("blobs from before partitions", () => {
  it("stay where they were, readable on the next use, when moving them fails", () => {
    failMove = true
    expect(get).toThrow("move failed")
    expect(fs.existsSync(targetDir())).toBe(false)
    expect(fs.existsSync(legacyFile())).toBe(true)
    expect(values.has(`mentraos_blobmeta_mu_1_${pkg}_take`)).toBe(true)

    failMove = false
    expect(get().result).toMatchObject({key: "take", bytes: 10})
    expect(fs.existsSync(path.join(targetDir(), fileName))).toBe(true)
  })

  it("move into a partition directory that already exists", () => {
    fs.mkdirSync(targetDir(), {recursive: true})
    expect(get().result).toMatchObject({key: "take", bytes: 10})
    expect(fs.existsSync(path.join(targetDir(), fileName))).toBe(true)
  })
})
