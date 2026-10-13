/**
 * @fileoverview The frozen preinstalled catalog Core still serves to released Mentra App versions.
 *
 * Core's built-in Store is gone. Mentra App versions released before the Store's
 * headless updates still install and update their preinstalled miniapps from
 * Core: `GET /api/client/miniapps`, `GET /api/client/miniapps/registry` and
 * `GET /api/client/miniapps/bundles/:assetId/download`. These tests seed the
 * catalog the way the earlier Core wrote it (raw rows, since nothing writes it
 * any more), drive the real Core app (`createApp`) with a phone access token,
 * and check that the Store's other routes, which the old Developer Console and
 * Core's Store administration used, are gone.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on that
 * database before any destructive call. The database is dropped in `afterAll`,
 * only if the check passed. Bundle bytes live in a temporary directory.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/legacy-miniapp-registry.integration.test.ts`
 */

import {generateKeyPairSync, randomUUID} from "node:crypto"
import {rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {afterAll, beforeAll, beforeEach, describe, expect, test} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {
  LegacyAssetModel,
  LegacyRegistryModel,
  LegacyRegistryRevisionModel,
  LegacyReleaseModel,
} from "../packages/core/src/models/legacy-miniapp-catalog.model"
import {createStorageService, sha256Hex} from "../packages/core/src/services/storage/storage.service"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const STORAGE_DIR = join(tmpdir(), `mentra-legacy-registry-test-${process.pid}`)
const ENV_KEYS = [
  "MENTRA_JWT_PRIVATE_KEY",
  "MENTRA_JWT_PUBLIC_KEY",
  "CLOUD_CORE_ISSUER",
  "CLOUD_CORE_ENVIRONMENT",
  "CLOUD_STORAGE_PROVIDER",
  "CLOUD_CORE_STORAGE_PROVIDER",
  "CLOUD_STORAGE_LOCAL_DIR",
  "CLOUD_CORE_LOCAL_STORAGE_DIR",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const CATALOG = ["preinstalled_registries", "preinstalled_registry_revisions", "miniapp_releases", "miniapp_assets"]

const {privateKey, publicKey} = generateKeyPairSync("ed25519")
const body = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")

let databaseUrl: string
let verified = false
let app: ReturnType<typeof createApp>
/** The collections the database held once Core's models were ready, before any test wrote the catalog. */
let collectionsAtStart: string[] = []

/** A phone's Mentra access token, as Core's token exchange issues it. */
async function phoneToken(tenantId = "mentra"): Promise<string> {
  return new jose.SignJWT({tenant_id: tenantId, session_id: "sess_legacy", jti: randomUUID()})
    .setProtectedHeader({alg: "EdDSA", kid: "mentra-access-1", typ: "JWT"})
    .setIssuer("cloud-core")
    .setAudience("cloud-core")
    .setSubject("mu_legacy_phone")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey)
}

async function get(path: string, bearer?: string): Promise<Response> {
  return app.request(`https://core.test${path}`, {headers: bearer ? {authorization: `Bearer ${bearer}`} : {}})
}

/** The catalog's collections, through the connection Core's models use. */
const catalog = (name: string) => LegacyRegistryModel.db.collection(name)
const objectId = () => new LegacyRegistryModel.base.Types.ObjectId()
const asObjectId = (id: string) => new LegacyRegistryModel.base.Types.ObjectId(id)

/**
 * One release with its bundle, as the earlier Core stored it: the bundle bytes in storage, an asset
 * row, and a release row. Returns the asset id.
 */
async function seedRelease(opts: {packageName: string; version: string; status?: string; role?: string}) {
  const bytes = new TextEncoder().encode(`zip bytes of ${opts.packageName}@${opts.version}`)
  const storageKey = `miniapps/${opts.packageName}/${opts.version}/bundle.zip`
  await createStorageService().putObject({key: storageKey, body: bytes, contentType: "application/zip"})
  const assetId = objectId()
  const sha256 = sha256Hex(bytes)
  await catalog("miniapp_assets").insertOne({
    _id: assetId,
    orgId: "org_first_party",
    miniAppId: `app_${opts.packageName}`,
    role: opts.role ?? "release_bundle",
    storageKey,
    fileName: `${opts.packageName}-${opts.version}.zip`,
    contentType: "application/zip",
    sizeBytes: bytes.byteLength,
    sha256,
    createdBy: "dev@example.test",
    createdAt: new Date("2026-07-01T00:00:00Z"),
  })
  const releaseId = objectId()
  await catalog("miniapp_releases").insertOne({
    _id: releaseId,
    orgId: "org_first_party",
    miniAppId: `app_${opts.packageName}`,
    packageName: opts.packageName,
    version: opts.version,
    status: opts.status ?? "published",
    manifest: {packageName: opts.packageName, version: opts.version},
    releaseBundleAssetId: assetId.toString(),
    bundleSha256: sha256,
    bundleSizeBytes: bytes.byteLength,
    createdBy: "dev@example.test",
  })
  return {assetId: assetId.toString(), releaseId: releaseId.toString(), bytes, sha256}
}

/** The active default registry for `environment`, naming `releases` in order. */
async function seedRegistry(environment: string, releases: Array<{releaseId: string}>, tenantId: string | null = null) {
  const registryId = objectId()
  const revisionId = objectId()
  await catalog("preinstalled_registry_revisions").insertOne({
    _id: revisionId,
    registryId: registryId.toString(),
    status: "active",
    reason: null,
    entries: releases.map((release, index) => ({
      _id: objectId(),
      miniAppId: `app_${index}`,
      releaseId: release.releaseId,
      required: index === 0,
      installPolicy: "keep_updated",
      minMobileVersion: index === 0 ? "2.0.0" : null,
      maxMobileVersion: null,
      priority: index,
    })),
    createdBy: "admin@example.test",
  })
  await catalog("preinstalled_registries").insertOne({
    _id: registryId,
    name: "default",
    environment,
    tenantId,
    status: "active",
    activeRevisionId: revisionId.toString(),
    createdBy: "admin@example.test",
  })
}

beforeAll(async () => {
  process.env.MENTRA_JWT_PRIVATE_KEY = body(privateKey.export({type: "pkcs8", format: "pem"}).toString())
  process.env.MENTRA_JWT_PUBLIC_KEY = body(publicKey.export({type: "spki", format: "pem"}).toString())
  delete process.env.CLOUD_CORE_ISSUER
  process.env.CLOUD_CORE_ENVIRONMENT = "prod"
  delete process.env.CLOUD_STORAGE_PROVIDER
  delete process.env.CLOUD_CORE_STORAGE_PROVIDER
  delete process.env.CLOUD_STORAGE_LOCAL_DIR
  process.env.CLOUD_CORE_LOCAL_STORAGE_DIR = STORAGE_DIR
  resetCoreKeyCaches()

  databaseUrl = localTestMongoUrl("legacy-miniapp-registry")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, LegacyRegistryModel.db.name)
  verified = true
  app = createApp({readinessChecks: []})
  await Promise.all([LegacyRegistryModel, LegacyRegistryRevisionModel, LegacyReleaseModel, LegacyAssetModel].map(model => model.init()))
  collectionsAtStart = (await LegacyRegistryModel.db.db!.listCollections({}, {nameOnly: true}).toArray()).map(c => c.name)
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, LegacyRegistryModel.db.name)
    await LegacyRegistryModel.db.dropDatabase()
  }
  await disconnectMongo()
  await rm(STORAGE_DIR, {recursive: true, force: true})
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  resetCoreKeyCaches()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, LegacyRegistryModel.db.name)
  for (const name of CATALOG) await catalog(name).deleteMany({})
})

describe("the frozen catalog", () => {
  test("Core neither creates the catalog's collections nor builds their indexes", () => {
    expect(collectionsAtStart.filter(name => CATALOG.includes(name))).toEqual([])
    for (const model of [LegacyRegistryModel, LegacyRegistryRevisionModel, LegacyReleaseModel, LegacyAssetModel]) {
      expect(model.schema.get("autoCreate")).toBe(false)
      expect(model.schema.get("autoIndex")).toBe(false)
    }
  })

  test("a phone reads the active registry of Core's environment and lists its packages", async () => {
    const recorder = await seedRelease({packageName: "com.mentra.recorder", version: "1.0.19"})
    const store = await seedRelease({packageName: "com.mentra.store", version: "1.0.4"})
    await seedRegistry("prod", [recorder, store])
    // Another environment's catalog is not this one's.
    await seedRegistry("dev", [await seedRelease({packageName: "com.mentra.dev-only", version: "0.0.1"})])
    const token = await phoneToken()

    const registry = await get("/api/client/miniapps/registry", token)
    expect(registry.status).toBe(200)
    const json = (await registry.json()) as {generatedAt: string; entries: Array<Record<string, unknown>>}
    expect(Number.isNaN(Date.parse(json.generatedAt))).toBe(false)
    expect(json.entries).toEqual([
      {
        packageName: "com.mentra.recorder",
        version: "1.0.19",
        bundleUrl: `https://core.test/api/client/miniapps/bundles/${recorder.assetId}/download`,
        bundleSha256: recorder.sha256,
        required: true,
        installPolicy: "keep_updated",
        channel: "prod",
        minMobileVersion: "2.0.0",
      },
      {
        packageName: "com.mentra.store",
        version: "1.0.4",
        bundleUrl: `https://core.test/api/client/miniapps/bundles/${store.assetId}/download`,
        bundleSha256: store.sha256,
        required: false,
        installPolicy: "keep_updated",
        channel: "prod",
      },
    ])

    const listed = await get("/api/client/miniapps", token)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([
      {packageName: "com.mentra.recorder", name: "com.mentra.recorder", version: "1.0.19"},
      {packageName: "com.mentra.store", name: "com.mentra.store", version: "1.0.4"},
    ])

    // A phone may still ask for an environment by name.
    const dev = (await (await get("/api/client/miniapps/registry?environment=dev", token)).json()) as {
      entries: Array<{packageName: string; channel: string}>
    }
    expect(dev.entries.map(entry => [entry.packageName, entry.channel])).toEqual([["com.mentra.dev-only", "dev"]])
  })

  test("a tenant's own registry wins over the shared one", async () => {
    await seedRegistry("prod", [await seedRelease({packageName: "com.mentra.shared", version: "1.0.0"})])
    await seedRegistry("prod", [await seedRelease({packageName: "com.oem.own", version: "2.0.0"})], "oem_tenant")

    const own = (await (await get("/api/client/miniapps/registry", await phoneToken("oem_tenant"))).json()) as {
      entries: Array<{packageName: string; tenantId?: string}>
    }
    expect(own.entries).toMatchObject([{packageName: "com.oem.own", tenantId: "oem_tenant"}])
    const shared = (await (await get("/api/client/miniapps/registry", await phoneToken())).json()) as {
      entries: Array<{packageName: string}>
    }
    expect(shared.entries.map(entry => entry.packageName)).toEqual(["com.mentra.shared"])
  })

  test("with no active registry the catalog is empty, and a release without its bundle is left out", async () => {
    const token = await phoneToken()
    expect(await (await get("/api/client/miniapps/registry", token)).json()).toMatchObject({entries: []})

    const kept = await seedRelease({packageName: "com.mentra.kept", version: "1.0.0"})
    const orphan = await seedRelease({packageName: "com.mentra.orphan", version: "1.0.0"})
    await catalog("miniapp_assets").deleteOne({_id: asObjectId(orphan.assetId)})
    await seedRegistry("prod", [orphan, kept])
    const json = (await (await get("/api/client/miniapps/registry", token)).json()) as {entries: Array<{packageName: string}>}
    expect(json.entries.map(entry => entry.packageName)).toEqual(["com.mentra.kept"])
  })

  test("the registry lists only bundles a phone can download", async () => {
    const released = await seedRelease({packageName: "com.mentra.released", version: "1.0.0"})
    const accepted = await seedRelease({packageName: "com.mentra.accepted", version: "1.0.0", status: "accepted"})
    const draft = await seedRelease({packageName: "com.mentra.draft", version: "1.0.0", status: "draft"})
    const suspended = await seedRelease({packageName: "com.mentra.suspended", version: "1.0.0", status: "suspended"})
    const icon = await seedRelease({packageName: "com.mentra.icon", version: "1.0.0", role: "store_icon"})
    await seedRegistry("prod", [draft, released, suspended, icon, accepted])

    const json = (await (await get("/api/client/miniapps/registry", await phoneToken())).json()) as {
      entries: Array<{packageName: string; bundleUrl: string}>
    }
    expect(json.entries.map(entry => entry.packageName)).toEqual(["com.mentra.released", "com.mentra.accepted"])
    for (const entry of json.entries) {
      expect([entry.packageName, (await get(new URL(entry.bundleUrl).pathname)).status]).toEqual([entry.packageName, 200])
    }
  })

  test("the registry and the listing need a phone access token", async () => {
    for (const path of ["/api/client/miniapps", "/api/client/miniapps/registry"]) {
      expect([path, (await get(path)).status]).toEqual([path, 400])
      expect([path, (await get(path, "not-a-token")).status]).toEqual([path, 400])
    }
  })
})

describe("bundle downloads", () => {
  test("a released bundle downloads without a token, with its digest", async () => {
    const release = await seedRelease({packageName: "com.mentra.captions", version: "1.0.22"})
    const response = await get(`/api/client/miniapps/bundles/${release.assetId}/download`)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(release.bytes)
    expect(response.headers.get("content-type")).toBe("application/zip")
    expect(response.headers.get("content-length")).toBe(String(release.bytes.byteLength))
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="com.mentra.captions-1.0.22.zip"')
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(response.headers.get("x-bundle-sha256")).toBe(release.sha256)
  })

  test("anything but a released bundle is not found, and nothing confirms an id exists", async () => {
    const draft = await seedRelease({packageName: "com.example.draft", version: "0.1.0", status: "draft"})
    const rejected = await seedRelease({packageName: "com.example.rejected", version: "0.1.0", status: "rejected"})
    const icon = await seedRelease({packageName: "com.example.icon", version: "0.1.0", role: "store_icon"})
    for (const id of [draft.assetId, rejected.assetId, icon.assetId, objectId().toString(), "not-an-id"]) {
      const response = await get(`/api/client/miniapps/bundles/${id}/download`)
      expect([id, response.status]).toEqual([id, 404])
      expect(await response.json()).toEqual({error: "not_found", error_description: "bundle asset not found"})
    }
  })
})

describe("the rest of Core's former Store", () => {
  test("the old Developer Console's API and sign-in are gone", async () => {
    for (const path of [
      "/api/console/health",
      "/api/console/auth/login",
      "/api/console/auth/callback",
      "/api/console/auth/me",
      "/api/console/org",
      "/api/console/apps",
      "/api/console/tokens",
      "/api/console/signing-keys",
    ]) {
      expect([path, (await get(path, await phoneToken())).status]).toEqual([path, 404])
    }
    const magic = await app.request("https://core.test/api/console/auth/magic/start", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({email: "dev@example.test"}),
    })
    expect(magic.status).toBe(404)
  })

  test("a phone cannot fetch a bundle by package name", async () => {
    expect((await get("/api/client/miniapps/com.mentra.recorder/bundle", await phoneToken())).status).toBe(404)
  })
})
