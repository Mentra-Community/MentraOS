/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import {FakeMmkv, fakeCreateMMKV, resetFakeMmkv} from "../../../services/fleet/__tests__/fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))

const {createCredentialVault} = await import("../credentialVault")
const {mmkvLegacyCredentials} = await import("../platform")
type CredentialVault = import("../credentialVault").CredentialVault
type LegacyCredentials = import("../credentialVault").LegacyCredentials
type SecureItemStore = import("../credentialVault").SecureItemStore

const ACCESS = "mentra.account.accessToken"
const REFRESH = "mentra.account.refreshToken"
const CLOUD = "mentra.cloud-client.refreshToken"
const WORKSPACE = "mentra.cloud-client.enterprise.https%3A%2F%2Facme.example.refreshToken"
const ITEM = "mentra.credentials.test"
const SCRUB_KEY = "mentra.credentials.scrub"

/** An MMKV instance that also records the scrub. */
class LegacyMmkv extends FakeMmkv {
  readonly writes: Array<{key: string; length: number}> = []
  trims = 0
  override set(key: string, value: string | number | boolean): void {
    this.writes.push({key, length: String(value).length})
    super.set(key, value)
  }
  trim(): void {
    this.trims += 1
  }
}

/**
 * The platform secure store. Its items outlive the app's MMKV, as the iOS Keychain outlives uninstalling the app.
 * Failures are switched on per test.
 */
class FakeSecureStore implements SecureItemStore {
  readonly items = new Map<string, string>()
  writes = 0
  deletes = 0
  failDeletes = false
  failWrites = false
  failReads = false
  /** Read back something other than what was written. */
  corruptReads = false
  /** The process dies while it waits for this read. */
  hangReads = false
  /** Writes wait for this, when set. */
  writeGate: Promise<void> | null = null

  async getItem(key: string): Promise<string | null> {
    if (this.hangReads) return new Promise<never>(() => {})
    if (this.failReads) throw new Error(`errSecInteractionNotAllowed reading ${key}`)
    const value = this.items.get(key) ?? null
    return this.corruptReads && value !== null ? value.slice(0, -2) : value
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.writeGate) await this.writeGate
    if (this.failWrites) throw new Error(`Keystore encryption failed for ${key}`)
    this.writes += 1
    this.items.set(key, value)
  }

  async deleteItem(key: string): Promise<void> {
    if (this.failDeletes) throw new Error(`Keychain delete failed for ${key}`)
    this.deletes += 1
    this.items.delete(key)
  }
}

/** The app's data that uninstalling removes: MMKV, with the move record. */
class AppData {
  legacy = new LegacyMmkv()
  record = new FakeMmkv()
  fileSize: number | null = 16384
}

let secure: FakeSecureStore
let data: AppData
let logs: string[]

function legacyFor(app: AppData, encoding: "json" | "raw" = "raw"): LegacyCredentials {
  return mmkvLegacyCredentials({
    keys: encoding === "json" ? [ACCESS, REFRESH] : "every key",
    encoding,
    isRetiredKey: encoding === "json" ? (key) => key.startsWith("supabase.auth.") : undefined,
    open: () => app.legacy,
    fileSize: () => app.fileSize,
  })
}

/** One launch of the app: a new process opens the same stores. */
function launch(options: {app?: AppData; legacy?: LegacyCredentials; encoding?: "json" | "raw"} = {}): CredentialVault {
  const app = options.app ?? data
  return createCredentialVault({
    name: "test",
    secure,
    moveRecord: () => app.record,
    legacy: options.legacy ?? legacyFor(app, options.encoding),
    log: (message) => logs.push(message),
  })
}

function legacyKeys(app: AppData = data): string[] {
  return app.legacy.getAllKeys().filter((key) => key !== SCRUB_KEY)
}

beforeEach(() => {
  resetFakeMmkv()
  secure = new FakeSecureStore()
  data = new AppData()
  logs = []
})

describe("the one-time move", () => {
  test("moves a signed-in person's credentials and deletes the MMKV copies", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.legacy.set(WORKSPACE, "workspace-refresh-1")

    const vault = launch()
    expect(await vault.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await vault.get(WORKSPACE)).toBe("workspace-refresh-1")
    expect(await vault.location()).toBe("secure-store")
    expect(legacyKeys()).toEqual([])
    expect(secure.items.has(ITEM)).toBe(true)
    expect(logs).toContain("CREDENTIALS(test): moved 2 credential(s) from MMKV to the secure store")
  })

  test("overwrites the removed copies in the MMKV file", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.fileSize = 32768

    await launch().location()
    // A value longer than the file makes MMKV write back first, then write it over everything left behind.
    const scrub = data.legacy.writes.find((write) => write.key === SCRUB_KEY)
    expect(scrub?.length).toBeGreaterThan(32768)
    expect(data.legacy.contains(SCRUB_KEY)).toBe(false)
    expect(data.legacy.trims).toBe(1)
    expect(data.record.getString("test.secureStore")).toBe("scrubbed-v1")
  })

  test("runs once: a later launch reads the secure store and writes nothing", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    await launch().location()
    const writes = secure.writes
    const scrubs = data.legacy.trims

    const next = launch()
    expect(await next.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await next.location()).toBe("secure-store")
    expect(secure.writes).toBe(writes)
    expect(data.legacy.trims).toBe(scrubs)
    expect(logs).toContain("CREDENTIALS(test): credentials are in the secure store")
  })

  test("a signed-out person moves nothing and stays signed out", async () => {
    const vault = launch()
    expect(await vault.get(CLOUD)).toBeNull()
    expect(await vault.location()).toBe("secure-store")
    expect(logs).toContain("CREDENTIALS(test): moved 0 credential(s) from MMKV to the secure store")

    await vault.set(CLOUD, "after-sign-in")
    expect(await launch().get(CLOUD)).toBe("after-sign-in")
  })

  test("a fresh install never signs in with a previous installation's secure-store credentials", async () => {
    data.legacy.set(CLOUD, "previous-installation")
    await launch().location()

    // Uninstalling removes MMKV, not the Keychain item.
    const reinstalled = new AppData()
    const vault = launch({app: reinstalled})
    expect(await vault.get(CLOUD)).toBeNull()
    expect([...secure.items.values()].join()).not.toContain("previous-installation")
  })

  test("a failed write keeps the MMKV copies, keeps the person signed in, and retries next launch", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    secure.failWrites = true

    const failed = launch()
    expect(await failed.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await failed.location()).toBe("mmkv")
    expect(data.legacy.getString(CLOUD)).toBe("cloud-refresh-1")
    expect(data.record.getString("test.secureStore")).toBeUndefined()
    // The token rotates while the store is unavailable: MMKV keeps the newest value.
    await failed.set(CLOUD, "cloud-refresh-2")
    expect(data.legacy.getString(CLOUD)).toBe("cloud-refresh-2")
    expect(logs.some((line) => line.includes("move failed; keeping the MMKV copies and retrying next launch"))).toBe(
      true,
    )

    secure.failWrites = false
    const retried = launch()
    expect(await retried.get(CLOUD)).toBe("cloud-refresh-2")
    expect(await retried.location()).toBe("secure-store")
    expect(legacyKeys()).toEqual([])
  })

  test("a read-back mismatch keeps the MMKV copies and the session", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    secure.corruptReads = true

    const vault = launch()
    expect(await vault.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await vault.location()).toBe("mmkv")
    expect(data.legacy.getString(CLOUD)).toBe("cloud-refresh-1")
    expect(logs.some((line) => line.includes("the secure store read back other data"))).toBe(true)

    secure.corruptReads = false
    expect(await launch().get(CLOUD)).toBe("cloud-refresh-1")
    expect(legacyKeys()).toEqual([])
  })

  test("while the move is pending, a store read error stays an error for keys MMKV no longer has", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.legacy.set(WORKSPACE, "workspace-refresh-1")
    await launch().location()
    // An older build wrote one copy; this launch cannot read the store to merge it.
    data.legacy.set(CLOUD, "cloud-refresh-from-older-build")
    secure.failReads = true
    const vault = launch()
    expect(await vault.location()).toBe("mmkv")
    expect(await vault.get(CLOUD)).toBe("cloud-refresh-from-older-build")
    await expect(vault.get(WORKSPACE)).rejects.toThrow("errSecInteractionNotAllowed")
  })

  test("a scrub filler a crash left behind is not moved as a credential", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.legacy.set(SCRUB_KEY, "0".repeat(1000))
    const vault = launch()
    expect(await vault.get(CLOUD)).toBe("cloud-refresh-1")
    expect(logs).toContain("CREDENTIALS(test): moved 1 credential(s) from MMKV to the secure store")
    expect(secure.items.get(ITEM)).not.toContain("000")
    expect(data.legacy.contains(SCRUB_KEY)).toBe(false)
  })

  test("a store that cannot be read at all keeps the MMKV copies", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    secure.failReads = true

    const vault = launch()
    expect(await vault.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await vault.location()).toBe("mmkv")
    expect(data.record.getString("test.secureStore")).toBeUndefined()
  })

  test("a crash after the write, before the move is recorded, moves again next launch", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    secure.hangReads = true
    // The process dies during the read-back.
    void launch().get(CLOUD)
    await Promise.resolve()
    expect(data.record.getString("test.secureStore")).toBeUndefined()
    expect(data.legacy.getString(CLOUD)).toBe("cloud-refresh-1")

    secure.hangReads = false
    const next = launch()
    expect(await next.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await next.location()).toBe("secure-store")
    expect(legacyKeys()).toEqual([])
  })

  test("a crash after the move is recorded, before the copies are deleted, loses nothing", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    const real = legacyFor(data)
    // The process dies before it deletes the copies, so it never scrubs either.
    await launch({legacy: {...real, eraseAll: () => {}, scrub: () => false}}).location()
    expect(data.record.getString("test.secureStore")).toBe("moved-v1")
    expect(data.legacy.getString(CLOUD)).toBe("cloud-refresh-1")

    const next = launch()
    expect(await next.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await next.location()).toBe("secure-store")
    expect(legacyKeys()).toEqual([])
    expect(data.record.getString("test.secureStore")).toBe("scrubbed-v1")
  })

  test("a crash before the scrub retries it next launch", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.fileSize = null
    await launch().location()
    expect(data.record.getString("test.secureStore")).toBe("moved-v1")
    expect(data.legacy.trims).toBe(0)

    data.fileSize = 16384
    expect(await launch().get(CLOUD)).toBe("cloud-refresh-1")
    expect(data.legacy.trims).toBe(1)
    expect(data.record.getString("test.secureStore")).toBe("scrubbed-v1")
  })

  test("copies an older build wrote after the move win over the stored ones", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.legacy.set(WORKSPACE, "workspace-refresh-1")
    await launch().location()

    // The person ran an older build, which signed in again through MMKV.
    data.legacy.set(CLOUD, "cloud-refresh-from-older-build")
    const next = launch()
    expect(await next.get(CLOUD)).toBe("cloud-refresh-from-older-build")
    expect(await next.get(WORKSPACE)).toBe("workspace-refresh-1")
    expect(legacyKeys()).toEqual([])
  })

  test("an MMKV copy that could not be deleted stays current until a launch deletes it", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    const real = legacyFor(data)
    const vault = launch({
      legacy: {
        ...real,
        eraseAll: () => {
          throw new Error("MMKV is read-only")
        },
      },
    })
    expect(await vault.location()).toBe("mmkv")
    await vault.set(CLOUD, "cloud-refresh-2")
    expect(data.legacy.getString(CLOUD)).toBe("cloud-refresh-2")

    expect(await launch().get(CLOUD)).toBe("cloud-refresh-2")
    expect(legacyKeys()).toEqual([])
  })

  test("a sign-out while the store is unusable reaches the stored copy too", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.legacy.set(WORKSPACE, "workspace-refresh-1")
    await launch().location()
    // An older build ran; then the store fails while moving its copy.
    data.legacy.set(CLOUD, "cloud-refresh-from-older-build")
    secure.failWrites = true

    const vault = launch()
    expect(await vault.location()).toBe("mmkv")
    expect(await vault.get(CLOUD)).toBe("cloud-refresh-from-older-build")
    // The store still holds this installation's credentials for keys MMKV no longer has.
    expect(await vault.get(WORKSPACE)).toBe("workspace-refresh-1")

    secure.failWrites = false
    await vault.delete(CLOUD)
    const next = launch()
    expect(await next.get(CLOUD)).toBeNull()
    expect(await next.get(WORKSPACE)).toBe("workspace-refresh-1")
  })
})

describe("token rotation and read errors", () => {
  test("a refresh during the move lands in the secure store, after the move", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    let open!: () => void
    secure.writeGate = new Promise<void>((resolve) => {
      open = resolve
    })
    const vault = launch()
    // cloud-client reads the token, Core rotates it, cloud-client saves the new one, all while the move waits.
    const read = vault.get(CLOUD)
    const rotated = vault.set(CLOUD, "cloud-refresh-2")
    await Promise.resolve()
    expect(data.legacy.getString(CLOUD)).toBe("cloud-refresh-1")
    secure.writeGate = null
    open()
    expect(await read).toBe("cloud-refresh-1")
    await rotated
    expect(data.legacy.getString(CLOUD)).toBeUndefined()
    expect(await launch().get(CLOUD)).toBe("cloud-refresh-2")
  })

  test("a read error is 'unavailable', never 'signed out'", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    await launch().location()
    // The device has not been unlocked since boot.
    secure.failReads = true
    const locked = launch()
    await expect(locked.get(CLOUD)).rejects.toThrow("errSecInteractionNotAllowed")
    expect(await locked.location()).toBe("secure-store")
    await expect(locked.set(WORKSPACE, "workspace-refresh-1")).rejects.toThrow("errSecInteractionNotAllowed")

    secure.failReads = false
    expect(await locked.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await launch().get(CLOUD)).toBe("cloud-refresh-1")
  })
})

describe("sign-out", () => {
  test("a delete the store cannot take stays deleted across relaunches until the store confirms it", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    data.legacy.set(WORKSPACE, "workspace-refresh-1")
    await launch().location()

    secure.failReads = true
    secure.failWrites = true
    const vault = launch()
    await vault.delete(CLOUD)
    expect(logs.some((line) => line.includes("it stays deleted and is retried"))).toBe(true)
    expect(data.record.getString("test.deleted")).toBe(JSON.stringify([CLOUD]))

    // Readable again, the store still holds the token until a launch writes it out.
    secure.failReads = false
    const relaunched = launch()
    secure.failWrites = true
    expect(await relaunched.get(CLOUD)).toBeNull()
    expect(await relaunched.get(WORKSPACE)).toBe("workspace-refresh-1")

    secure.failWrites = false
    const recovered = launch()
    expect(await recovered.get(CLOUD)).toBeNull()
    expect(secure.items.get(ITEM)).not.toContain("cloud-refresh-1")
    expect(data.record.getString("test.deleted")).toBeUndefined()
    expect(await recovered.get(WORKSPACE)).toBe("workspace-refresh-1")
  })

  test("a clear the store cannot take stays in force across relaunches, and a new sign-in replaces it", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    await launch().location()
    secure.failDeletes = true
    await launch().clear()

    const relaunched = launch()
    expect(await relaunched.get(CLOUD)).toBeNull()
    // Signing in again writes a fresh item, which settles the clear.
    await relaunched.set(WORKSPACE, "workspace-refresh-2")
    expect(data.record.getString("test.deleted")).toBeUndefined()
    secure.failDeletes = false
    const next = launch()
    expect(await next.get(CLOUD)).toBeNull()
    expect(await next.get(WORKSPACE)).toBe("workspace-refresh-2")
  })

  test("clear deletes every credential without reading the item", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    await launch().location()
    secure.failReads = true
    const vault = launch()
    await vault.clear()
    expect(secure.items.has(ITEM)).toBe(false)
    expect(await vault.get(CLOUD)).toBeNull()
    secure.failReads = false
    expect(await launch().get(CLOUD)).toBeNull()
  })

  test("a sign-out reaches the store even when this launch could not read MMKV to know the move had finished", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    await launch().location()
    const getString = data.record.getString.bind(data.record)
    let failures = 1
    data.record.getString = (key: string) => {
      if (failures-- > 0) throw new Error("MMKV could not load")
      return getString(key)
    }
    const vault = launch()
    expect(await vault.location()).toBe("mmkv")
    await vault.clear()
    data.record.getString = getString
    expect(await launch().get(CLOUD)).toBeNull()
  })

  test("clear during a pending move deletes the MMKV copies too", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    secure.failWrites = true
    const vault = launch()
    expect(await vault.location()).toBe("mmkv")
    await vault.clear()
    expect(legacyKeys()).toEqual([])
    secure.failWrites = false
    expect(await launch().get(CLOUD)).toBeNull()
  })
})

describe("after the move", () => {
  test("nothing reads MMKV, and every write removes a stray MMKV copy", async () => {
    const vault = launch()
    await vault.set(CLOUD, "cloud-refresh-1")
    data.legacy.set(WORKSPACE, "planted-after-the-move")
    const reads: string[] = []
    const getString = data.legacy.getString.bind(data.legacy)
    data.legacy.getString = (key: string) => {
      reads.push(key)
      return getString(key)
    }

    expect(await vault.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await vault.get(WORKSPACE)).toBeNull()
    await vault.set(WORKSPACE, "workspace-refresh-1")
    await vault.delete(CLOUD)
    expect(reads).toEqual([])
    expect(data.legacy.contains(WORKSPACE)).toBe(false)
    expect(await vault.get(WORKSPACE)).toBe("workspace-refresh-1")
    expect(await vault.get(CLOUD)).toBeNull()
  })

  test("keeps every write when calls overlap, including calls made during the move", async () => {
    data.legacy.set(CLOUD, "cloud-refresh-1")
    const vault = launch()
    const keys = Array.from({length: 20}, (_, index) => `mentra.cloud-client.deployment-${index}.refreshToken`)
    await Promise.all(keys.map((key, index) => vault.set(key, `token-${index}`)))
    await vault.delete(keys[3])

    const next = launch()
    expect(await next.get(CLOUD)).toBe("cloud-refresh-1")
    expect(await next.get(keys[0])).toBe("token-0")
    expect(await next.get(keys[3])).toBeNull()
    expect(await next.get(keys[19])).toBe("token-19")
  })

  test("a failed write surfaces and the next read reflects the stored item", async () => {
    const vault = launch()
    await vault.set(CLOUD, "cloud-refresh-1")
    secure.failWrites = true
    await expect(vault.set(CLOUD, "cloud-refresh-2")).rejects.toThrow("Keystore encryption failed")
    secure.failWrites = false
    expect(await vault.get(CLOUD)).toBe("cloud-refresh-1")
  })

  test("deletes retired credentials whenever they turn up, and scrubs them", async () => {
    data.legacy.set(ACCESS, JSON.stringify("account-access"))
    await launch({encoding: "json"}).location()
    const scrubs = data.legacy.trims

    data.legacy.set("supabase.auth.token", JSON.stringify({access_token: "supabase-access"}))
    const next = launch({encoding: "json"})
    expect(await next.get(ACCESS)).toBe("account-access")
    expect(data.legacy.contains("supabase.auth.token")).toBe(false)
    expect(data.legacy.trims).toBe(scrubs + 1)
    expect(data.record.getString("test.secureStore")).toBe("scrubbed-v1")
    expect(logs).toContain("CREDENTIALS(test): deleted retired credentials from MMKV")
  })

  test("an unreadable item is treated as empty, so the person can sign in again", async () => {
    await launch().location()
    secure.items.set(ITEM, "not json")
    const vault = launch()
    expect(await vault.get(CLOUD)).toBeNull()
    await vault.set(CLOUD, "cloud-refresh-1")
    expect(await launch().get(CLOUD)).toBe("cloud-refresh-1")
  })
})

describe("app storage copies", () => {
  test("decodes values the app wrote with storage.save and deletes retired Supabase keys", async () => {
    data.legacy.set(ACCESS, JSON.stringify("account-access"))
    data.legacy.set(REFRESH, JSON.stringify("account-refresh"))
    data.legacy.set("supabase.auth.token", JSON.stringify({access_token: "supabase-access"}))
    data.legacy.set("mentra.account.userProfile", JSON.stringify(JSON.stringify({id: "user-1"})))

    const vault = launch({encoding: "json"})
    expect(await vault.get(ACCESS)).toBe("account-access")
    expect(await vault.get(REFRESH)).toBe("account-refresh")
    expect(legacyKeys()).toEqual(["mentra.account.userProfile"])
  })

  test("keeps a saved object as its JSON text", () => {
    const authing = {access_token: "authing-access", refresh_token: "authing-refresh", expires_at: 1}
    data.legacy.set("authing_session", JSON.stringify(authing))
    const legacy = mmkvLegacyCredentials({keys: ["authing_session"], encoding: "json", open: () => data.legacy})
    expect(JSON.parse(legacy.readAll().authing_session)).toEqual(authing)
  })

  test("writes while the move is pending stay readable by an older build", async () => {
    data.legacy.set(ACCESS, JSON.stringify("account-access"))
    secure.failWrites = true
    const vault = launch({encoding: "json"})
    await vault.set(ACCESS, "account-access-2")
    expect(JSON.parse(data.legacy.getString(ACCESS)!)).toBe("account-access-2")
  })
})

test("never logs a credential", async () => {
  data.legacy.set(CLOUD, "secret-cloud-refresh")
  data.legacy.set(WORKSPACE, "secret-workspace-refresh")
  secure.failWrites = true
  await launch().location()
  secure.failWrites = false
  const vault = launch()
  await vault.set(CLOUD, "secret-rotated")
  secure.items.set(ITEM, "secret-garbage")
  await launch().get(CLOUD)

  expect(logs.length).toBeGreaterThan(0)
  for (const line of logs) expect(line).not.toContain("secret")
})
