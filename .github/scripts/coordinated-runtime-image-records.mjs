#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const IMAGE = "ghcr.io/mentra-community/mentra-cloud"
const PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
const ATTESTATION_REPOSITORY = "Mentra-Community/MentraOS"

function requireHttps(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`)
  }
  return parsed.toString().replace(/\/$/, "")
}

function requireIsoUtc(value, label) {
  const parsed = new Date(value)
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`)
  }
  return value
}

function validatePlan(plan, sourceCommit) {
  if (
    plan?.schemaVersion !== 1 ||
    !["dev", "beta"].includes(plan.channel) ||
    plan.releaseSetId !== `mentra-${plan.releaseIdentity}` ||
    plan.sourceCommit !== sourceCommit
  ) {
    throw new Error("Runtime image inputs do not match a coordinated prerelease plan")
  }
}

function requestedTags(plan) {
  return {
    release: plan.releaseIdentity,
    source: plan.sourceCommit,
  }
}

export function createRuntimeImageRecord({
  plan,
  sourceCommit,
  status,
  digest,
  sbom,
  provenanceAttestationUrl,
  completedAt,
  workflowUrl,
}) {
  validatePlan(plan, sourceCommit)
  if (!["published", "validated"].includes(status)) {
    throw new Error("Runtime image status must be published or validated")
  }

  const record = {
    schemaVersion: 1,
    component: "mentra-cloud-image",
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    sourceCommit,
    channel: plan.channel,
    status,
    image: IMAGE,
    requestedTags: requestedTags(plan),
    completedAt: requireIsoUtc(completedAt, "completedAt"),
    workflowUrl: requireHttps(workflowUrl, "workflowUrl"),
  }

  if (status === "published") {
    if (!DIGEST_PATTERN.test(digest || "")) {
      throw new Error("Published Runtime image requires an immutable SHA-256 digest")
    }
    if (
      sbom?.format !== "spdx-json" ||
      typeof sbom.name !== "string" ||
      !sbom.name.endsWith(".spdx.json") ||
      !SHA256_PATTERN.test(sbom.sha256 || "") ||
      !Number.isSafeInteger(sbom.size) ||
      sbom.size < 1
    ) {
      throw new Error("Published Runtime image requires valid SPDX SBOM evidence")
    }
    record.digest = digest
    record.reference = `${IMAGE}@${digest}`
    record.sbom = {
      format: sbom.format,
      name: sbom.name,
      sha256: sbom.sha256,
      size: sbom.size,
      attestationUrl: requireHttps(sbom.attestationUrl, "sbom.attestationUrl"),
    }
    record.provenance = {
      predicateType: PROVENANCE_PREDICATE_TYPE,
      repository: ATTESTATION_REPOSITORY,
      ...(provenanceAttestationUrl
        ? {attestationUrl: requireHttps(provenanceAttestationUrl, "provenanceAttestationUrl")}
        : {}),
    }
  }

  return record
}

export function validateRuntimeImageRecord({plan, record, allowValidated = false}) {
  validatePlan(plan, record?.sourceCommit)
  if (
    record.schemaVersion !== 1 ||
    record.component !== "mentra-cloud-image" ||
    record.releaseSetId !== plan.releaseSetId ||
    record.releaseIdentity !== plan.releaseIdentity ||
    record.channel !== plan.channel ||
    record.image !== IMAGE ||
    JSON.stringify(record.requestedTags) !== JSON.stringify(requestedTags(plan))
  ) {
    throw new Error("Runtime image record does not match the release plan")
  }
  requireIsoUtc(record.completedAt, "runtimeImage.completedAt")
  requireHttps(record.workflowUrl, "runtimeImage.workflowUrl")
  if (record.status === "validated") {
    if (
      record.digest !== undefined ||
      record.reference !== undefined ||
      record.sbom !== undefined ||
      record.provenance !== undefined
    ) {
      throw new Error("Validation-only Runtime image evidence must not claim a publication")
    }
    if (allowValidated) return record
  }
  if (record.status !== "published") throw new Error("Runtime image record is not a completed publication")
  if (!DIGEST_PATTERN.test(record.digest || "")) {
    throw new Error("Published Runtime image requires an immutable SHA-256 digest")
  }
  if (record.reference !== `${IMAGE}@${record.digest}`) {
    throw new Error("Runtime image reference does not match its immutable digest")
  }
  if (
    record.provenance?.predicateType !== PROVENANCE_PREDICATE_TYPE ||
    record.provenance?.repository !== ATTESTATION_REPOSITORY
  ) {
    throw new Error("Published Runtime image requires verified build provenance")
  }
  return createRuntimeImageRecord({
    plan,
    sourceCommit: record.sourceCommit,
    status: record.status,
    digest: record.digest,
    sbom: record.sbom,
    provenanceAttestationUrl: record.provenance?.attestationUrl,
    completedAt: record.completedAt,
    workflowUrl: record.workflowUrl,
  })
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const plan = readJson(args.plan)
  if (command === "validate") {
    validateRuntimeImageRecord({
      plan,
      record: readJson(args.record),
      allowValidated: args["allow-validated"] === "true",
    })
    return
  }
  if (command !== "create") throw new Error(`Unknown command ${JSON.stringify(command)}`)
  const record = createRuntimeImageRecord({
    plan,
    sourceCommit: args["source-commit"],
    status: args.status,
    digest: args.digest,
    sbom: args["sbom-name"]
      ? {
          format: "spdx-json",
          name: args["sbom-name"],
          sha256: args["sbom-sha256"],
          size: Number(args["sbom-size"]),
          attestationUrl: args["sbom-attestation-url"],
        }
      : undefined,
    provenanceAttestationUrl: args["provenance-attestation-url"],
    completedAt: args["completed-at"],
    workflowUrl: args["workflow-url"],
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(record, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
