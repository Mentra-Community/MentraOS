/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// --- In-memory RNFS ---------------------------------------------------------
// Keyed by absolute path; value is the "content" whose sha256 we fake as
// `sha:<content>` so hashes are deterministic and human-readable in failures.
const files = new Map<string, string>()
const hashes: Record<string, string> = {
  apk: "a".repeat(64),
  mtk: "b".repeat(64),
  bes: "c".repeat(64),
  corrupted: "d".repeat(64),
  tampered: "e".repeat(64),
}
const fakeHash = (content: string) => hashes[content] ?? "f".repeat(64)
let downloadImpl: (options: {fromUrl: string; toFile: string}) => Promise<{statusCode: number}> = async () => ({
  statusCode: 200,
})

const rnfsMock = {
  DocumentDirectoryPath: "/docs",
  mkdir: mock(async () => undefined),
  exists: mock(async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`))),
  hash: mock(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`no such file ${path}`)
    return fakeHash(content)
  }),
  unlink: mock(async (path: string) => {
    files.delete(path)
  }),
  moveFile: mock(async (from: string, to: string) => {
    const content = files.get(from)
    if (content === undefined) throw new Error(`no such file ${from}`)
    files.delete(from)
    files.set(to, content)
  }),
  readDir: mock(async () =>
    [...files.keys()]
      .filter((path) => path.startsWith("/docs/ota_artifacts/"))
      .map((path) => ({
        path,
        name: path.split("/").pop()!,
        isFile: () => true,
      })),
  ),
  downloadFile: mock((options: {fromUrl: string; toFile: string}) => ({
    jobId: 1,
    promise: downloadImpl(options),
  })),
}

mock.module("@dr.pogodin/react-native-fs", () => ({
  ...rnfsMock,
  default: rnfsMock,
}))

const {
  OtaArtifactError,
  cleanupArtifacts,
  planArtifacts,
  prepareArtifacts,
  rewriteManifestForLocalServer,
  verifyPreparedArtifacts,
} =
  await import("../OtaArtifactDownloader")

const APK_URL = "https://cdn.example.com/asg.apk"
const MTK_URL = "https://cdn.example.com/mtk.zip"
const BES_URL = "https://cdn.example.com/bes.bin"

const manifest = {
  apps: {
    "com.mentra.asg_client": {
      versionCode: 100,
      versionName: "100",
      apkUrl: APK_URL,
      apkSize: 1234,
      sha256: hashes.apk,
    },
  },
  mtk_patches: [
    {start_firmware: "A", end_firmware: "B", url: MTK_URL, sha256: hashes.mtk},
    {start_firmware: "B", end_firmware: "C", url: "https://cdn.example.com/other.zip"},
  ],
  bes_firmware: {version: "9.9.9", url: BES_URL, sha256: hashes.bes},
}

function checkResult(overrides: Record<string, unknown> = {}) {
  return {
    hasCheckCompleted: true,
    updateAvailable: true,
    latestVersionInfo: null,
    updates: ["apk", "mtk", "bes"],
    mtkPatch: {start_firmware: "A", end_firmware: "B", url: MTK_URL},
    besVersion: "9.9.9",
    isApkDowngrade: false,
    manifestBody: JSON.stringify(manifest),
    updateInfo: null,
    isRequired: false,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  files.clear()
  downloadImpl = async ({fromUrl, toFile}) => {
    files.set(toFile, contentFor(fromUrl))
    return {statusCode: 200}
  }
})

function contentFor(url: string): string {
  if (url === APK_URL) return "apk"
  if (url === MTK_URL) return "mtk"
  if (url === BES_URL) return "bes"
  return "unknown"
}

describe("planArtifacts", () => {
  test("plans every pending artifact from the raw manifest", () => {
    const plan = planArtifacts(checkResult())
    expect(plan).toEqual([
      {kind: "apk", url: APK_URL, expectedSha256: hashes.apk, sizeBytes: 1234},
      {kind: "mtk", url: MTK_URL, expectedSha256: hashes.mtk, sizeBytes: null},
      {kind: "bes", url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null},
    ])
  })

  test("plans only the updates the check reported", () => {
    const plan = planArtifacts(checkResult({updates: ["bes"], mtkPatch: null}))
    expect(plan.map((entry) => entry.kind)).toEqual(["bes"])
  })

  test("throws when the check carries no manifest", () => {
    expect(() => planArtifacts(checkResult({manifestBody: null}))).toThrow(OtaArtifactError)
  })

  test("throws when a pending APK update has no URL", () => {
    const broken = {...manifest, apps: {"com.mentra.asg_client": {versionCode: 100}}}
    expect(() => planArtifacts(checkResult({manifestBody: JSON.stringify(broken)}))).toThrow("no apkUrl")
  })

  test("accepts legacy firmwareUrl keys", () => {
    const legacy = {
      ...manifest,
      bes_firmware: {version: "9.9.9", firmwareUrl: BES_URL, sha256: hashes.bes},
    }
    const plan = planArtifacts(checkResult({updates: ["bes"], mtkPatch: null, manifestBody: JSON.stringify(legacy)}))
    expect(plan).toEqual([{kind: "bes", url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null}])
  })

  test("rejects a selected artifact without a manifest hash", () => {
    const broken = {
      ...manifest,
      mtk_patches: [{start_firmware: "A", end_firmware: "B", url: MTK_URL}],
    }
    expect(() => planArtifacts(checkResult({manifestBody: JSON.stringify(broken)}))).toThrow("manifest sha256")
  })
})

describe("prepareArtifacts", () => {
  test("downloads, verifies, and stores by hash", async () => {
    const plan = [{kind: "bes" as const, url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null}]
    const prepared = await prepareArtifacts(plan)
    expect(prepared).toHaveLength(1)
    expect(prepared[0].sha256).toBe(hashes.bes)
    expect(prepared[0].filePath).toBe(`/docs/ota_artifacts/${hashes.bes}`)
    expect(files.has(`/docs/ota_artifacts/${hashes.bes}`)).toBe(true)
  })

  test("reuses a cached artifact that still verifies", async () => {
    files.set(`/docs/ota_artifacts/${hashes.bes}`, "bes")
    downloadImpl = async () => {
      throw new Error("should not download")
    }
    const plan = [{kind: "bes" as const, url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null}]
    const prepared = await prepareArtifacts(plan)
    expect(prepared[0].filePath).toBe(`/docs/ota_artifacts/${hashes.bes}`)
  })

  test("re-downloads when the cached file no longer verifies", async () => {
    files.set(`/docs/ota_artifacts/${hashes.bes}`, "corrupted")
    const plan = [{kind: "bes" as const, url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null}]
    const prepared = await prepareArtifacts(plan)
    expect(prepared[0].sha256).toBe(hashes.bes)
    expect(files.get(`/docs/ota_artifacts/${hashes.bes}`)).toBe("bes")
  })

  test("fails verification on a hash mismatch and cleans the staging file", async () => {
    downloadImpl = async ({toFile}) => {
      files.set(toFile, "tampered")
      return {statusCode: 200}
    }
    const plan = [{kind: "bes" as const, url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null}]
    await expect(prepareArtifacts(plan)).rejects.toThrow("hash mismatch")
    expect([...files.keys()].some((path) => path.endsWith(".part"))).toBe(false)
  })

  test("keys manifest-less MTK artifacts by their computed hash", async () => {
    const plan = [{kind: "mtk" as const, url: MTK_URL, expectedSha256: null, sizeBytes: null}]
    const prepared = await prepareArtifacts(plan)
    expect(prepared[0].sha256).toBe(hashes.mtk)
    expect(prepared[0].filePath).toBe(`/docs/ota_artifacts/${hashes.mtk}`)
  })

  test("surfaces HTTP failures as artifact_download_failed", async () => {
    downloadImpl = async () => ({statusCode: 503})
    const plan = [{kind: "bes" as const, url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null}]
    await expect(prepareArtifacts(plan)).rejects.toMatchObject({code: "artifact_download_failed"})
  })
})

describe("rewriteManifestForLocalServer", () => {
  test("changes only hosted URL fields", async () => {
    const prepared = await prepareArtifacts(planArtifacts(checkResult()))
    const rewritten = JSON.parse(
      rewriteManifestForLocalServer(JSON.stringify(manifest), prepared, "http://192.168.43.100:8791"),
    )

    expect(rewritten.apps["com.mentra.asg_client"].apkUrl).toBe(
      `http://192.168.43.100:8791/artifacts/${hashes.apk}`,
    )
    expect(rewritten.apps["com.mentra.asg_client"].versionCode).toBe(100)
    expect(rewritten.mtk_patches[0].url).toBe(`http://192.168.43.100:8791/artifacts/${hashes.mtk}`)
    expect(rewritten.mtk_patches[0].sha256).toBe(hashes.mtk)
    // Entries the update does not host keep their CDN URLs.
    expect(rewritten.mtk_patches[1].url).toBe("https://cdn.example.com/other.zip")
    expect(rewritten.bes_firmware.url).toBe(`http://192.168.43.100:8791/artifacts/${hashes.bes}`)
  })

  test("overwrites legacy firmwareUrl keys so no build prefers a stale CDN URL", async () => {
    const legacy = {
      bes_firmware: {version: "9.9.9", url: BES_URL, firmwareUrl: BES_URL, sha256: hashes.bes},
    }
    const prepared = await prepareArtifacts([{kind: "bes", url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null}])
    const rewritten = JSON.parse(rewriteManifestForLocalServer(JSON.stringify(legacy), prepared, "http://host:1"))
    expect(rewritten.bes_firmware.url).toBe(`http://host:1/artifacts/${hashes.bes}`)
    expect(rewritten.bes_firmware.firmwareUrl).toBe(`http://host:1/artifacts/${hashes.bes}`)
  })
})

describe("verifyPreparedArtifacts", () => {
  test("re-verifies staged content immediately before serving", async () => {
    const prepared = await prepareArtifacts([
      {kind: "bes", url: BES_URL, expectedSha256: hashes.bes, sizeBytes: null},
    ])
    await expect(verifyPreparedArtifacts(prepared)).resolves.toBeUndefined()
    files.set(prepared[0].filePath, "tampered")
    await expect(verifyPreparedArtifacts(prepared)).rejects.toThrow("changed before serving")
  })
})

describe("cleanupArtifacts", () => {
  test("removes everything not explicitly kept", async () => {
    files.set(`/docs/ota_artifacts/${hashes.apk}`, "apk")
    files.set(`/docs/ota_artifacts/${hashes.bes}`, "bes")
    files.set("/docs/ota_artifacts/download-0.part", "partial")
    await cleanupArtifacts([hashes.apk])
    expect([...files.keys()]).toEqual([`/docs/ota_artifacts/${hashes.apk}`])
  })
})
