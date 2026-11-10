import {describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {inflateRawSync} from "node:zlib"

import {
  applyMiniappVariants,
  parseMiniappVariants,
  resolveMiniappVariant,
  rewriteMiniappManifest,
  stampMiniappVariant,
  VARIANT_MIN_HOST_VERSION,
} from "./miniapp-variant"

const REFERENCE = join(import.meta.dir, "../../../../deploy/azure/enterprise-reference/miniapps")
/** Mentra Call 2.1.62 as pinned by the reference: built before Call read a variant's backend. */
const PINNED_CALL_ZIP = new Uint8Array(readFileSync(join(REFERENCE, "com.mentra.call-2.1.62.zip")))
/** The same bundle as a build that declares it accepts a variant. */
const CALL_ZIP = rewriteMiniappManifest(PINNED_CALL_ZIP, (manifest) => ({...manifest, acceptsVariant: true}))
const ACME = {packageName: "com.acme.call", backendUrl: "https://call.acme.example"}

/** Read one entry of a ZIP the simple way, through its central directory. */
function readEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--
  let position = view.getUint32(eocd + 16, true)
  for (let i = 0; i < view.getUint16(eocd + 10, true); i++) {
    const nameLength = view.getUint16(position + 28, true)
    const entryName = new TextDecoder().decode(zip.subarray(position + 46, position + 46 + nameLength))
    if (entryName === name) {
      const method = view.getUint16(position + 10, true)
      const size = view.getUint32(position + 20, true)
      const local = view.getUint32(position + 42, true)
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const raw = zip.subarray(start, start + size)
      return method === 0 ? raw : new Uint8Array(inflateRawSync(raw))
    }
    position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true)
  }
  return null
}

function manifestOf(zip: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(readEntry(zip, "miniapp.json")!))
}

describe("resolveMiniappVariant", () => {
  test("defaults both halves and treats an unchanged pair as no variant", () => {
    expect(resolveMiniappVariant("com.mentra.call", {})).toBeNull()
    expect(resolveMiniappVariant("com.mentra.call", {packageName: "com.mentra.call"})).toBeNull()
    expect(resolveMiniappVariant("com.mentra.call", {backendUrl: "https://call.acme.example/"})).toEqual({
      packageName: "com.mentra.call",
      backendUrl: "https://call.acme.example",
    })
  })

  test("refuses a renamed package without its backend", () => {
    expect(() => resolveMiniappVariant("com.mentra.call", {packageName: "com.acme.call"})).toThrow(
      "needs its backendUrl",
    )
  })

  test("refuses unsafe backend URLs and unknown fields", () => {
    for (const backendUrl of [
      "http://call.acme.example",
      "https://user:pass@call.acme.example",
      "https://call.acme.example/?x=1",
      "https://call.acme.example/#x",
      "not a url",
    ]) {
      expect(() => resolveMiniappVariant("com.mentra.call", {...ACME, backendUrl})).toThrow()
    }
    expect(() => resolveMiniappVariant("com.mentra.call", {...ACME, extra: 1})).toThrow("unknown fields")
    expect(() => resolveMiniappVariant("com.mentra.call", {...ACME, packageName: "acme"})).toThrow("invalid")
  })

  test("parses the environment and refuses one name for two variants", () => {
    expect(parseMiniappVariants(undefined)).toEqual({})
    expect(parseMiniappVariants(" ")).toEqual({})
    expect(parseMiniappVariants(JSON.stringify({"com.mentra.call": ACME}))).toEqual({"com.mentra.call": ACME})
    expect(() => parseMiniappVariants("[]")).toThrow("JSON object")
    expect(() =>
      parseMiniappVariants(
        JSON.stringify({
          "com.mentra.call": ACME,
          "com.mentra.enterprise": {...ACME, backendUrl: "https://e.acme.example"},
        }),
      ),
    ).toThrow("used twice")
  })
})

describe("stampMiniappVariant", () => {
  test("stamps the pair into miniapp.json and keeps every other file", () => {
    const stamped = stampMiniappVariant(CALL_ZIP, "com.mentra.call", ACME)
    const manifest = manifestOf(stamped.bytes)
    const original = manifestOf(CALL_ZIP)
    expect(manifest).toEqual({
      ...original,
      packageName: "com.acme.call",
      minHostVersion: VARIANT_MIN_HOST_VERSION,
      variant: {of: "com.mentra.call", backendUrl: "https://call.acme.example"},
    })
    expect(stamped).toMatchObject({packageName: "com.acme.call", version: original.version})
    expect(stamped.sha256).toBe(createHash("sha256").update(stamped.bytes).digest("hex"))
    for (const name of ["background/index.js", "ui/index.html", "icon.png"]) {
      expect(Buffer.from(readEntry(stamped.bytes, name)!)).toEqual(Buffer.from(readEntry(PINNED_CALL_ZIP, name)!))
    }
  })

  test("is deterministic, so a restart never changes an installed version's digest", () => {
    const first = stampMiniappVariant(CALL_ZIP, "com.mentra.call", ACME)
    const second = stampMiniappVariant(CALL_ZIP, "com.mentra.call", ACME)
    expect(second.sha256).toBe(first.sha256)
  })

  test("refuses a build that does not declare it accepts a variant", () => {
    // 2.1.62 keeps calling its compiled backend, so a renamed copy could never sign in.
    expect(manifestOf(PINNED_CALL_ZIP).acceptsVariant).toBeUndefined()
    expect(() => stampMiniappVariant(PINNED_CALL_ZIP, "com.mentra.call", ACME)).toThrow("does not accept a variant")
  })

  test("refuses another package's bundle and an already stamped one", () => {
    expect(() => stampMiniappVariant(CALL_ZIP, "com.mentra.enterprise", ACME)).toThrow("not com.mentra.enterprise")
    const stamped = stampMiniappVariant(CALL_ZIP, "com.mentra.call", ACME)
    expect(() =>
      stampMiniappVariant(stamped.bytes, "com.acme.call", {
        packageName: "com.other.call",
        backendUrl: "https://o.example",
      }),
    ).toThrow("already a variant")
  })
})

describe("applyMiniappVariants", () => {
  const sha256 = createHash("sha256").update(CALL_ZIP).digest("hex")
  const manifest = JSON.stringify({
    services: {runtimeUrl: "https://workspace.acme.example"},
    miniapps: {
      managed: [
        {
          packageName: "com.mentra.call",
          version: "2.1.62",
          bundleUrl: "https://workspace.acme.example/miniapps/com.mentra.call-2.1.62.zip",
          sha256,
        },
      ],
      configuration: {},
    },
  })
  const bundles = [{path: "/miniapps/com.mentra.call-2.1.62.zip", body: CALL_ZIP.slice().buffer}]

  test("leaves the manifest untouched without variants", async () => {
    const served = await applyMiniappVariants(manifest, bundles, {})
    expect(served.manifest).toBe(manifest)
    expect(served.bundles).toBe(bundles)
  })

  test("replaces the managed entry and the served bundle with the variant", async () => {
    const served = await applyMiniappVariants(manifest, bundles, {"com.mentra.call": ACME})
    const entry = JSON.parse(served.manifest).miniapps.managed[0]
    const stamped = stampMiniappVariant(CALL_ZIP, "com.mentra.call", ACME)
    expect(entry).toEqual({
      packageName: "com.acme.call",
      version: "2.1.62",
      bundleUrl: "https://workspace.acme.example/miniapps/com.acme.call-2.1.62.zip",
      sha256: stamped.sha256,
    })
    expect(served.bundles).toHaveLength(1)
    expect(served.bundles[0]!.path).toBe("/miniapps/com.acme.call-2.1.62.zip")
    const body = new Uint8Array(served.bundles[0]!.body as ArrayBuffer)
    expect(createHash("sha256").update(body).digest("hex")).toBe(entry.sha256)
  })

  test("refuses a variant the deployment cannot serve or does not manage", async () => {
    await expect(applyMiniappVariants(manifest, [], {"com.mentra.call": ACME})).rejects.toThrow(
      "DEPLOYMENT_MANAGED_MINIAPP_DIR",
    )
    await expect(
      applyMiniappVariants(manifest, bundles, {
        "com.mentra.enterprise": {packageName: "com.acme.demo", backendUrl: "https://demo.acme.example"},
      }),
    ).rejects.toThrow("does not manage")
    await expect(applyMiniappVariants("", bundles, {"com.mentra.call": ACME})).rejects.toThrow(
      "need a deployment manifest",
    )
  })

  test("refuses configuration still keyed by the source package", async () => {
    const configured = JSON.parse(manifest)
    configured.miniapps.configuration = {"com.mentra.call": {backendUrl: "https://elsewhere.example"}}
    await expect(applyMiniappVariants(JSON.stringify(configured), bundles, {"com.mentra.call": ACME})).rejects.toThrow(
      "key it by its variant",
    )
  })
})
