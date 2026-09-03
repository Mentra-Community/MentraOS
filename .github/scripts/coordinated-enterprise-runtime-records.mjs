#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const CANONICAL_IMAGE = "ghcr.io/mentra-community/mentra-cloud"
const TARGET = Object.freeze({
  environment: "enterprise-dev",
  resourceGroup: "rg-mentra-enterprise-reference",
  registry: "mentraenterpriseref",
  containerApp: "ca-mentra-enterprise-reference",
  coreContainerApp: "ca-mentra-enterprise-reference-core",
  imageRepository: "mentra-cloud-enterprise",
  workspaceOrigin: "https://enterprisedev.mentraglass.com",
  services: Object.freeze(["meetings"]),
  meetingProvider: "acs-teams",
})

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
    plan.channel !== "dev" ||
    plan.releaseSetId !== `mentra-${plan.releaseIdentity}` ||
    plan.sourceCommit !== sourceCommit
  ) {
    throw new Error("Enterprise Runtime deployment inputs do not match a dev release plan")
  }
}

function validateChecks(checks, workspaceOrigin, coreOrigin) {
  if (!Array.isArray(checks) || checks.length !== 4) {
    throw new Error("Private deployment must record Core and Runtime healthz and ready checks")
  }
  const expected = new Set([
    `${workspaceOrigin}/healthz`,
    `${workspaceOrigin}/ready`,
    `${coreOrigin}/healthz`,
    `${coreOrigin}/ready`,
  ])
  for (const check of checks) {
    if (
      !expected.delete(check?.url) ||
      check.ready !== true ||
      !Number.isInteger(check.statusCode) ||
      check.statusCode < 200 ||
      check.statusCode >= 300
    ) {
      throw new Error("Enterprise Runtime deployment contains an invalid readiness check")
    }
  }
  if (expected.size !== 0) throw new Error("Enterprise Runtime deployment checks are incomplete")
  return [...checks].sort((left, right) => left.url.localeCompare(right.url))
}

export function createEnterpriseRuntimeDeploymentRecord({
  plan,
  sourceCommit,
  requestedTag,
  status,
  sourceImage,
  sourceImageDigest,
  image,
  imageDigest,
  revision,
  coreRevision,
  workspaceOrigin,
  coreOrigin,
  checks,
  completedAt,
  provenanceUrl,
}) {
  validatePlan(plan, sourceCommit)
  if (!COMMIT_PATTERN.test(requestedTag || "") || requestedTag !== sourceCommit) {
    throw new Error("requestedTag must equal the full sourceCommit")
  }
  if (!["deployed", "validated"].includes(status)) {
    throw new Error("Enterprise Runtime deployment status must be deployed or validated")
  }
  const record = {
    schemaVersion: 1,
    component: "enterprise-runtime",
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    sourceCommit,
    channel: plan.channel,
    environment: TARGET.environment,
    status,
    services: [...TARGET.services],
    meetingProvider: TARGET.meetingProvider,
    azure: {
      resourceGroup: TARGET.resourceGroup,
      registry: TARGET.registry,
      containerApp: TARGET.containerApp,
      coreContainerApp: TARGET.coreContainerApp,
      imageRepository: TARGET.imageRepository,
      requestedTag,
    },
    completedAt: requireIsoUtc(completedAt, "completedAt"),
    provenanceUrl: requireHttps(provenanceUrl, "provenanceUrl"),
  }
  if (status === "deployed") {
    if (
      sourceImage !== CANONICAL_IMAGE ||
      !DIGEST_PATTERN.test(sourceImageDigest || "") ||
      sourceImageDigest !== imageDigest
    ) {
      throw new Error("Enterprise Runtime deployment is missing its canonical GHCR source")
    }
    const expectedImage = `${TARGET.registry}.azurecr.io/${TARGET.imageRepository}@${imageDigest}`
    if (image !== expectedImage || !DIGEST_PATTERN.test(imageDigest || "") || !revision || !coreRevision) {
      throw new Error("Enterprise Runtime deployment is missing immutable Azure image evidence")
    }
    const origin = requireHttps(workspaceOrigin, "workspaceOrigin")
    if (origin !== TARGET.workspaceOrigin) {
      throw new Error("Enterprise Runtime deployment uses the wrong workspace origin")
    }
    record.source = {
      image: sourceImage,
      imageDigest: sourceImageDigest,
      reference: `${sourceImage}@${sourceImageDigest}`,
    }
    record.azure.image = image
    record.azure.imageDigest = imageDigest
    record.azure.revision = revision
    record.azure.coreRevision = coreRevision
    record.workspaceOrigin = origin
    record.coreOrigin = requireHttps(coreOrigin, "coreOrigin")
    record.checks = validateChecks(checks, origin, record.coreOrigin)
  }
  return record
}

function assertCanonicalRuntimeImage(record, runtimeImage) {
  if (!runtimeImage) return
  if (record.status === "validated" && runtimeImage.status === "validated") return
  if (
    record.status !== "deployed" ||
    runtimeImage.status !== "published" ||
    runtimeImage.image !== CANONICAL_IMAGE ||
    record.source?.imageDigest !== runtimeImage.digest
  ) {
    throw new Error("Enterprise Runtime deployment does not match the coordinated Runtime image")
  }
}

export function validateEnterpriseRuntimeDeploymentRecord({plan, record, allowValidated = false, runtimeImage}) {
  validatePlan(plan, record?.sourceCommit)
  if (
    record.schemaVersion !== 1 ||
    record.component !== "enterprise-runtime" ||
    record.releaseSetId !== plan.releaseSetId ||
    record.releaseIdentity !== plan.releaseIdentity ||
    record.channel !== plan.channel ||
    record.environment !== TARGET.environment ||
    JSON.stringify(record.services) !== JSON.stringify(TARGET.services) ||
    record.meetingProvider !== TARGET.meetingProvider ||
    record.azure?.resourceGroup !== TARGET.resourceGroup ||
    record.azure?.registry !== TARGET.registry ||
    record.azure?.containerApp !== TARGET.containerApp ||
    record.azure?.coreContainerApp !== TARGET.coreContainerApp ||
    record.azure?.imageRepository !== TARGET.imageRepository ||
    record.azure?.requestedTag !== plan.sourceCommit
  ) {
    throw new Error("Enterprise Runtime deployment record does not match the release plan and target")
  }
  requireIsoUtc(record.completedAt, "enterpriseRuntime.completedAt")
  requireHttps(record.provenanceUrl, "enterpriseRuntime.provenanceUrl")
  if (record.status === "validated") {
    if (
      record.azure.image !== undefined ||
      record.azure.imageDigest !== undefined ||
      record.azure.revision !== undefined ||
      record.azure.coreRevision !== undefined ||
      record.source !== undefined ||
      record.workspaceOrigin !== undefined ||
      record.coreOrigin !== undefined ||
      record.checks !== undefined
    ) {
      throw new Error("Validation-only Enterprise Runtime evidence must not claim a live deployment")
    }
    if (allowValidated) {
      assertCanonicalRuntimeImage(record, runtimeImage)
      return record
    }
  }
  if (record.status !== "deployed") throw new Error("Enterprise Runtime record is not a completed deployment")
  if (record.source?.reference !== `${CANONICAL_IMAGE}@${record.source?.imageDigest}`) {
    throw new Error("Enterprise Runtime canonical source reference is inconsistent")
  }
  const validated = createEnterpriseRuntimeDeploymentRecord({
    plan,
    sourceCommit: record.sourceCommit,
    requestedTag: record.azure.requestedTag,
    status: record.status,
    sourceImage: record.source.image,
    sourceImageDigest: record.source.imageDigest,
    image: record.azure.image,
    imageDigest: record.azure.imageDigest,
    revision: record.azure.revision,
    coreRevision: record.azure.coreRevision,
    workspaceOrigin: record.workspaceOrigin,
    coreOrigin: record.coreOrigin,
    checks: record.checks,
    completedAt: record.completedAt,
    provenanceUrl: record.provenanceUrl,
  })
  assertCanonicalRuntimeImage(validated, runtimeImage)
  return validated
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
  if (command !== "create") throw new Error(`Unknown command ${JSON.stringify(command)}`)
  const args = parseArgs(rest)
  const record = createEnterpriseRuntimeDeploymentRecord({
    plan: readJson(args.plan),
    sourceCommit: args["source-commit"],
    requestedTag: args["requested-tag"],
    status: args.status,
    sourceImage: args["source-image"],
    sourceImageDigest: args["source-image-digest"],
    image: args.image,
    imageDigest: args["image-digest"],
    revision: args.revision,
    coreRevision: args["core-revision"],
    workspaceOrigin: args["workspace-origin"],
    coreOrigin: args["core-origin"],
    checks: args.checks ? readJson(args.checks) : undefined,
    completedAt: args["completed-at"],
    provenanceUrl: args["provenance-url"],
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(record, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
