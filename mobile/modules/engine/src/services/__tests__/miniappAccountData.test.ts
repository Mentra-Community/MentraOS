/// <reference types="bun-types" />
import {afterEach, beforeEach, describe, expect, it, mock} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {fakeCreateMMKV, resetFakeMmkv} from "../fleet/__tests__/fakeMmkv"

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
}
mock.module("expo-file-system", () => ({Directory, File, Paths}))
mock.module("react-native-share", () => ({default: {open: async () => {}}}))
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: () => null}}))
mock.module("@mentra/miniapp", () => ({MiniappErrorCode: {BLOB_NOT_FOUND: "BLOB_NOT_FOUND"}}))
mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))

const partitions = await import("../miniappDataPartition")
const {deleteMiniappDataOfAccount, isMiniappKeyKeptAtSignOut} = await import("../miniappAccountData")
const {LocalMiniappStorage} = await import("../LocalMiniappStorage")
const {BlobStore} = await import("../BlobStore")
const {openMiniappWebStorage, applyMiniappWebStorageOps, miniappWebStorageEntries, resetMiniappWebStorageForTests} =
  await import("../miniappWebStorage")
const {storage} = await import("../../utils/storage/storage")

const CORE = "https://core.mentra.glass"
const pkg = "com.mentra.documentation"
const ALICE = {coreUrl: CORE, mentraUserId: "mu_alice"}
const BOB = {coreUrl: CORE, mentraUserId: "mu_bob"}
let session: {coreUrl: string; mentraUserId: string} | null
let root: string

const simpleStorage = new LocalMiniappStorage({
  getPartition: async (packageName) => partitions.resolveMiniappDataPartition(packageName),
  backend: {
    get: (key) => {
      const value = storage.load<unknown>(key)
      return value.is_ok() ? value.value : null
    },
    has: (key) => storage.load<unknown>(key).is_ok(),
    set: (key, value) => void storage.save(key, value),
    remove: (key) => void storage.remove(key),
    keys: () => storage.getAllKeys(),
  },
})

function blobStore() {
  const results: unknown[] = []
  const store = new BlobStore({
    sendResult: (_pkg, _id, _ok, result) => results.push(result),
    getPartition: (packageName) => partitions.resolveMiniappDataPartition(packageName),
  })
  return {
    list: () => {
      store.handleList(pkg, {})
      return (results.at(-1) as {blobs: Array<{key: string; bytes: number; uri: string}>}).blobs
    },
    /** A saved file, as a commit leaves it: its bytes in the partition's directory and its record. */
    save: (key: string, bytes: string) => {
      const dir = store.ownFilesDirectory(pkg)
      const fileName = `${key}-file.pdf`
      fs.writeFileSync(path.join(dir.uri, fileName), bytes)
      const partitionId = partitions.resolveMiniappDataPartition(pkg).id
      storage.save(`mentraos_blobmeta/${partitionId}/${pkg}/${key}`, {
        key,
        fileName,
        mimeType: "application/pdf",
        bytes: bytes.length,
        createdAt: 1,
        updatedAt: 1,
      })
    },
  }
}

function webCopy() {
  return openMiniappWebStorage({
    packageName: pkg,
    origin: "https://com-mentra-documentation.miniapp.local",
    partitionId: partitions.resolveMiniappDataPartition(pkg).id,
  })
}

/** What signing out leaves of the default MMKV instance at most: miniapp account data. The session is gone. */
function signOut() {
  storage.removeMultiple(storage.getAllKeys().filter((key) => !isMiniappKeyKeptAtSignOut(key)))
  resetMiniappWebStorageForTests()
  session = null
}

function signIn(account: {coreUrl: string; mentraUserId: string}) {
  session = account
}

/** Everything one account's Documentation miniapp has on this phone. */
async function documentationData() {
  return {
    storage: await simpleStorage.getAll(pkg),
    blobs: blobStore()
      .list()
      .map((blob) => ({key: blob.key, bytes: blob.bytes, contents: fs.readFileSync(blob.uri, "utf8")})),
    web: miniappWebStorageEntries(webCopy()),
  }
}

beforeEach(() => {
  partitions.resetMiniappDataPartitionsForTests()
  resetMiniappWebStorageForTests()
  resetFakeMmkv()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "miniapp-account-data-test-"))
  Paths.document = path.join(root, "documents")
  session = ALICE
  partitions.configureMiniappDataPartitions({getSession: () => session, assignedWorkspace: () => null})
})
afterEach(() => fs.rmSync(root, {recursive: true}))

async function aliceWritesReports() {
  await simpleStorage.set(pkg, "reports", JSON.stringify([{id: "r1", transcript: "Inspection notes"}]))
  blobStore().save("r1-photo", "photo bytes")
  blobStore().save("r1-pdf", "pdf bytes")
  const copy = webCopy()
  applyMiniappWebStorageOps(copy, [["set", "draft", "half-written report"]])
}

describe("a miniapp's data across sign-out", () => {
  it("is exactly as it was when the same account signs back in", async () => {
    await aliceWritesReports()
    const before = await documentationData()
    expect(before.storage).toEqual({reports: JSON.stringify([{id: "r1", transcript: "Inspection notes"}])})
    expect(before.blobs.map((blob) => blob.key).sort()).toEqual(["r1-pdf", "r1-photo"])
    expect(before.web).toEqual({draft: "half-written report"})

    signOut()
    signIn(ALICE)

    expect(await documentationData()).toEqual(before)
  })

  it("is not seen by another account signing in on the same phone, and is still there for its own", async () => {
    await aliceWritesReports()
    const alices = await documentationData()

    signOut()
    signIn(BOB)
    expect(await documentationData()).toEqual({storage: {}, blobs: [], web: {}})
    await simpleStorage.set(pkg, "reports", "[]")

    signOut()
    signIn(ALICE)
    expect(await documentationData()).toEqual(alices)
  })
})

describe("deleting an account", () => {
  it("erases every partition of that account, its files included, after its session is gone", async () => {
    await aliceWritesReports()
    partitions.setFleetWorkspace(ALICE, "ws_1")
    const aliceDir = path.join(Paths.document, "mentra_blobs", partitions.resolveMiniappDataPartition(pkg).id)
    partitions.setFleetWorkspace(ALICE, null)
    const personalDir = path.join(Paths.document, "mentra_blobs", partitions.resolveMiniappDataPartition(pkg).id)
    expect(fs.existsSync(personalDir)).toBe(true)

    signOut()
    signIn(BOB)
    await simpleStorage.set(pkg, "reports", "[bob]")
    blobStore().save("b1", "bob's pdf")
    const bobs = await documentationData()
    signOut()

    // The deletion runs once the confirm call has ended the session.
    expect(partitions.lastMiniappDataSession()).toEqual(BOB)
    signIn(ALICE)
    await simpleStorage.get(pkg, "reports")
    partitions.syncDevelopmentSelections()
    storage.save(`${pkg}_dev_url`, "http://192.168.1.4:8081")
    storage.save("dev_apps_index", JSON.stringify([pkg]))
    session = null
    deleteMiniappDataOfAccount()

    const left = storage.getAllKeys()
    const alicePartition = partitions.partitionIdOf({...ALICE, workspaceId: null}).slice(0, -1)
    expect(left.filter((key) => key.includes(alicePartition))).toEqual([])
    expect(fs.existsSync(personalDir)).toBe(false)
    expect(fs.existsSync(aliceDir)).toBe(false)
    expect(partitions.getFleetWorkspace(ALICE)).toBeNull()
    expect(storage.getAllKeys().filter(partitions.isDevelopmentSelectionKey)).toEqual([])

    signIn(ALICE)
    expect(await documentationData()).toEqual({storage: {}, blobs: [], web: {}})
    signIn(BOB)
    expect(await documentationData()).toEqual(bobs)
  })

  it("erases the account's data from before partitions too", () => {
    storage.save(`mentraos_localstorage_mu_alice_${pkg}_reports`, "[old]")
    storage.save(`mentraos_blobmeta_mu_alice_${pkg}_old`, {key: "old", fileName: "old.pdf"})
    storage.save(`mentraos_localstorage_mu_bob_${pkg}_reports`, "[bob]")
    const legacyDir = path.join(Paths.document, "mentra_blobs", "mu_alice", pkg)
    fs.mkdirSync(legacyDir, {recursive: true})
    fs.writeFileSync(path.join(legacyDir, "old.pdf"), "old")

    deleteMiniappDataOfAccount(ALICE)

    expect(storage.getAllKeys()).toEqual([`mentraos_localstorage_mu_bob_${pkg}_reports`])
    expect(fs.existsSync(legacyDir)).toBe(false)
  })
})
