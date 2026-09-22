import {expect, test} from "bun:test"
import {mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {bindFullOtaProof} from "./full-ota-proof"
import {hash, reference} from "./day1-local-io"

async function fixture(body: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "full-ota-proof-"))
  try {
    await body(await setup(directory))
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
}

async function setup(directory: string) {
  const freeze = async (name: string, value: unknown) => {
    const path = join(directory, name)
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), {mode: 0o600})
    return reference(path)
  }
  const log =
    "Verified correct signature 1 out of 1 signatures.\n".repeat(2) +
    "The new partition (boot) is valid.\nThe new partition (system) is valid.\n"
  const request = {
    schema: 2,
    request_id: "20260101T000000Z-abcdef123456",
    base_revision: "b".repeat(40),
    with_ota: true,
    clean: false,
  }
  const buildId = "test-project:unit-test"
  const verification = {
    otaSha256: "a".repeat(64),
    otaBytes: 100,
    target: {version: "MentraLive_20260102.0", timestamp: "12345"},
    payload: {
      minorVersion: 0,
      maxTimestamp: 12345,
      powerwash: false,
      payloadSha256: "c".repeat(64),
      partitions: ["boot", "system"].map((name) => ({name, size: 4096, sha256: "d".repeat(64), operations: 1})),
    },
    targetPartitionDeclarations: ["boot", "system", "system"],
    hardwareQualification: "not-run",
    payloadSignatureVerification: "passed",
    targetPartitionVerification: "passed",
    certificateSha256: "e".repeat(64),
    nativeLogSha256: hash(log),
  }
  const result = {
    status: "artifact-verified",
    hardwareStarted: false,
    requestId: request.request_id,
    sourceRevision: request.base_revision,
    otaSha256: verification.otaSha256,
    targetTargetFilesSha256: "f".repeat(64),
    verification,
  }
  const build = {
    id: buildId,
    sourceVersion: request.base_revision,
    resolvedSourceVersion: request.base_revision,
    currentPhase: "COMPLETED",
    buildStatus: "SUCCEEDED",
  }
  const evidence = {
    "remote-result.json": await freeze("remote-result.json", result),
    "native-command.json": await freeze("native-command.json", ["unit-verifier", "test data; must never execute"]),
    "native-verification.log": await freeze("native-verification.log", log),
    "codebuild-final.json": await freeze("codebuild-final.json", {builds: [build]}),
    "intent.json": await freeze("intent.json", {
      request,
      hardwareStarted: false,
      firmwareGenerated: false,
      publicPublication: false,
    }),
    "request.json": await freeze("request.json", request),
    "broker-submitted.json": await freeze("broker-submitted.json", {
      schema: 1,
      build_id: buildId,
      request_id: request.request_id,
    }),
  }
  const packet = {
    schemaVersion: 1,
    kind: "mtk-full-ota-offline-verification",
    hardwareQualification: "not-run",
    fullPayload: true,
    powerwash: false,
    payloadSignatureVerification: "passed",
    targetPartitionVerification: "passed",
    otaSha256: verification.otaSha256,
    otaBytes: verification.otaBytes,
    targetVersion: verification.target.version,
    targetTimestamp: verification.target.timestamp,
    sourceRevision: request.base_revision,
    payloadSha256: verification.payload.payloadSha256,
    targetTargetFilesSha256: result.targetTargetFilesSha256,
    certificateSha256: verification.certificateSha256,
    requestId: request.request_id,
    codebuildId: buildId,
    partitionNames: ["boot", "system"],
    evidence,
  }
  const manifest = {
    apps: {
      "com.mentra.asg_client": {versionCode: 100, apkUrl: "https://example.invalid/asg.apk", sha256: "1".repeat(64)},
    },
    bes_firmware: {version: "26.1.2.3", url: "https://example.invalid/bes.bin", sha256: "2".repeat(64)},
    mtk_full_ota: {
      end_firmware: "20260102.0",
      url: "https://example.invalid/full.zip",
      sha256: verification.otaSha256,
      size: verification.otaBytes,
    },
  }
  const input = {
    proof: await freeze("proof.json", packet),
    manifest: {...(await freeze("manifest.json", manifest)), url: "https://example.invalid/manifest.json"},
  }
  const updateProof = async () => {
    input.proof = await freeze("proof.json", packet)
  }
  return {input, packet, verification, result, build, manifest, freeze, updateProof}
}

test("binds a reviewed native result to exact manifest bytes without a device-pass claim", () =>
  fixture(async (f) => {
    const output = await bindFullOtaProof(f.input)
    expect(output.manifestSha256).toBe(f.input.manifest.sha256)
    expect(output.targetVersion).toBe("MentraLive_20260102.0")
    expect(output.offlineProof).toEqual(f.input.proof)
    expect(output.hardwareQualification).toBe("not-run")
  }))

test("rejects another selected OTA even when version text matches", () =>
  fixture(async (f) => {
    f.manifest.mtk_full_ota.sha256 = "9".repeat(64)
    f.input.manifest = {...(await f.freeze("manifest.json", f.manifest)), url: f.input.manifest.url}
    await expect(bindFullOtaProof(f.input)).rejects.toThrow("selected full OTA")
  }))

test("rejects tampered retained evidence before trusting copied passed flags", () =>
  fixture(async (f) => {
    await writeFile(f.packet.evidence["native-verification.log"].path, "replacement")
    await expect(bindFullOtaProof(f.input)).rejects.toThrow("Frozen file changed")
  }))

test.each(["FAILED", "IN_PROGRESS"])("rejects a %s build despite a nominal passed report", (status) =>
  fixture(async (f) => {
    f.build.buildStatus = status
    f.packet.evidence["codebuild-final.json"] = await f.freeze("codebuild-final.json", {builds: [f.build]})
    await f.updateProof()
    await expect(bindFullOtaProof(f.input)).rejects.toThrow("completed build")
  }),
)

test("rejects a native result from another source", () =>
  fixture(async (f) => {
    f.result.sourceRevision = "9".repeat(40)
    f.packet.evidence["remote-result.json"] = await f.freeze("remote-result.json", f.result)
    await f.updateProof()
    await expect(bindFullOtaProof(f.input)).rejects.toThrow("same verification")
  }))

test("requires the complete target partition set", () =>
  fixture(async (f) => {
    f.verification.targetPartitionDeclarations.push("vendor")
    f.packet.evidence["remote-result.json"] = await f.freeze("remote-result.json", f.result)
    await f.updateProof()
    await expect(bindFullOtaProof(f.input)).rejects.toThrow("every target partition")
  }))

test("rejects a signature-only log without partition validation", () =>
  fixture(async (f) => {
    f.packet.evidence["native-verification.log"] = await f.freeze(
      "native-verification.log",
      "Verified correct signature 1 out of 1 signatures.\n".repeat(2),
    )
    f.verification.nativeLogSha256 = f.packet.evidence["native-verification.log"].sha256
    f.packet.evidence["remote-result.json"] = await f.freeze("remote-result.json", f.result)
    await f.updateProof()
    await expect(bindFullOtaProof(f.input)).rejects.toThrow("complete partition validation")
  }))

test("rejects the January powerwash package as a normal restore", () =>
  fixture(async (f) => {
    f.packet.powerwash = true
    await f.updateProof()
    await expect(bindFullOtaProof(f.input)).rejects.toThrow("selected full OTA")
  }))
