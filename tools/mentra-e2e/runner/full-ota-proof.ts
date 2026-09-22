import {isDeepStrictEqual as same} from "node:util"
import {file, json, requireThat, type Ref} from "./day1-local-io"
import {parseFirmwareProfile} from "./firmware-profile"
import {normalizeFirmware} from "./ota-state"

const SHA = /^[a-f\d]{64}$/
const evidenceNames = [
  "remote-result.json",
  "native-command.json",
  "native-verification.log",
  "codebuild-final.json",
  "intent.json",
  "request.json",
  "broker-submitted.json",
]
const sorted = (values: string[]) => [...values].sort()

/** Bind a reviewed offline verification packet to exact selected manifest bytes.
 * This checks retained evidence, not AWS authentication or device qualification.
 * The operator pins the original packet after authenticating the private build.
 * No remote command from the packet is ever executed. */
export async function bindFullOtaProof(input: {proof: Ref; manifest: Ref & {url: string}}) {
  const manifest = await file(input.manifest)
  const profile = parseFirmwareProfile(manifest, input.manifest)
  const proof = await json(input.proof)
  requireThat(
    proof.schemaVersion === 1 &&
      proof.kind === "mtk-full-ota-offline-verification" &&
      proof.hardwareQualification === "not-run" &&
      proof.fullPayload === true &&
      proof.powerwash === false &&
      proof.payloadSignatureVerification === "passed" &&
      proof.targetPartitionVerification === "passed" &&
      proof.otaSha256 === profile.mtk.artifact.sha256 &&
      proof.otaBytes === profile.mtk.artifact.size &&
      normalizeFirmware(proof.targetVersion) === profile.mtk.version &&
      /^[a-f\d]{40}$/.test(proof.sourceRevision) &&
      [proof.payloadSha256, proof.targetTargetFilesSha256, proof.certificateSha256].every((value) => SHA.test(value)) &&
      /^[\d]{8}T[\d]{6}Z-[a-f\d]{12}$/.test(proof.requestId) &&
      typeof proof.codebuildId === "string" &&
      Array.isArray(proof.partitionNames) &&
      proof.partitionNames.length > 0 &&
      proof.partitionNames.every((name: unknown) => typeof name === "string" && /^[a-z0-9_]+$/.test(name)) &&
      new Set(proof.partitionNames).size === proof.partitionNames.length,
    "Offline proof is incomplete or differs from the selected full OTA",
  )
  requireThat(
    proof.evidence && same(Object.keys(proof.evidence).sort(), sorted(evidenceNames)),
    "Incomplete native verification evidence",
  )
  const evidence = new Map<string, Buffer>()
  for (const name of evidenceNames) evidence.set(name, await file(proof.evidence[name], 8 * 1024 * 1024))
  const object = (name: string) => JSON.parse(evidence.get(name)!.toString())
  const result = object("remote-result.json"),
    verification = result.verification
  const request = object("request.json"),
    intent = object("intent.json"),
    submitted = object("broker-submitted.json")
  const builds = object("codebuild-final.json").builds
  requireThat(
    request.schema === 2 &&
      request.request_id === proof.requestId &&
      request.base_revision === proof.sourceRevision &&
      request.with_ota === true &&
      request.clean === false &&
      same(intent.request, request) &&
      intent.hardwareStarted === false &&
      intent.firmwareGenerated === false &&
      intent.publicPublication === false &&
      submitted.schema === 1 &&
      submitted.request_id === proof.requestId &&
      submitted.build_id === proof.codebuildId &&
      Array.isArray(builds) &&
      builds.length === 1 &&
      builds[0].id === proof.codebuildId &&
      builds[0].sourceVersion === proof.sourceRevision &&
      builds[0].resolvedSourceVersion === proof.sourceRevision &&
      builds[0].currentPhase === "COMPLETED" &&
      builds[0].buildStatus === "SUCCEEDED" &&
      result.status === "artifact-verified" &&
      result.hardwareStarted === false &&
      result.requestId === proof.requestId &&
      result.sourceRevision === proof.sourceRevision &&
      result.otaSha256 === proof.otaSha256 &&
      result.targetTargetFilesSha256 === proof.targetTargetFilesSha256,
    "Native result, request and completed build do not describe the same verification",
  )
  requireThat(
    verification?.otaSha256 === proof.otaSha256 &&
      verification.otaBytes === proof.otaBytes &&
      verification.hardwareQualification === "not-run" &&
      verification.payloadSignatureVerification === "passed" &&
      verification.targetPartitionVerification === "passed" &&
      verification.certificateSha256 === proof.certificateSha256 &&
      verification.nativeLogSha256 === proof.evidence["native-verification.log"].sha256 &&
      verification.target?.version === proof.targetVersion &&
      verification.target.timestamp === proof.targetTimestamp &&
      verification.payload?.minorVersion === 0 &&
      verification.payload.powerwash === false &&
      verification.payload.payloadSha256 === proof.payloadSha256 &&
      String(verification.payload.maxTimestamp) === proof.targetTimestamp &&
      Array.isArray(verification.payload.partitions) &&
      verification.payload.partitions.every(
        (partition: any) =>
          Number.isSafeInteger(partition.size) &&
          partition.size > 0 &&
          SHA.test(partition.sha256) &&
          Number.isSafeInteger(partition.operations) &&
          partition.operations > 0,
      ) &&
      same(
        sorted(verification.payload.partitions.map((partition: any) => partition.name)),
        sorted(proof.partitionNames),
      ) &&
      Array.isArray(verification.targetPartitionDeclarations) &&
      same(sorted([...new Set<string>(verification.targetPartitionDeclarations)]), sorted(proof.partitionNames)),
    "Native verification does not cover the exact full payload and every target partition",
  )
  const command = object("native-command.json")
  requireThat(
    Array.isArray(command) && command.length > 0 && command.every((value) => typeof value === "string"),
    "Missing native command evidence",
  )
  const log = evidence.get("native-verification.log")!.toString()
  const signatures = log.match(/Verified correct signature 1 out of 1 signatures/g) ?? []
  const partitions = [...log.matchAll(/The new partition \(([a-z0-9_]+)\) is valid\./g)].map((match) => match[1])
  requireThat(
    signatures.length >= 2 && same(sorted(partitions), sorted(proof.partitionNames)),
    "Native log lacks signature or complete partition validation",
  )
  return {
    schemaVersion: 1,
    kind: "manifest-bound-full-ota-verification",
    manifestSha256: profile.manifest.sha256,
    targetVersion: profile.mtk.version,
    otaSha256: proof.otaSha256,
    otaBytes: proof.otaBytes,
    fullPayload: true,
    powerwash: false,
    payloadSignatureVerification: verification.payloadSignatureVerification,
    targetPartitionVerification: verification.targetPartitionVerification,
    hardwareQualification: "not-run",
    offlineProof: input.proof,
    sourceRevision: proof.sourceRevision,
    requestId: proof.requestId,
    codebuildId: proof.codebuildId,
    evidence: proof.evidence,
  }
}
