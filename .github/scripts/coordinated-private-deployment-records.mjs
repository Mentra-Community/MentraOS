#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const CANONICAL_IMAGE = "ghcr.io/mentra-community/mentra-cloud"
const IMAGE_REPOSITORY = "mentra-cloud-enterprise"
const SERVICES = Object.freeze(["realtime-audio", "camera", "tts", "meetings"])
const MEETING_PROVIDER = "acs-teams"
// Each prerelease channel deploys its own Acme demo stack. Keep these in step
// with the stack table in .github/workflows/private-deployment.yml.
export const TARGETS = Object.freeze({
  dev: Object.freeze({
    environment: "enterprise-demo-dev",
    resourceGroup: "rg-mentra-enterprise-demo-dev",
    registry: "mentraenterprisedemodev",
    containerApp: "ca-mentra-ent-demo-dev",
    coreContainerApp: "ca-mentra-ent-demo-dev-core",
    workspaceOrigin: "https://demo-dev.acmeworkspace.com",
  }),
  beta: Object.freeze({
    environment: "enterprise-demo",
    resourceGroup: "rg-mentra-enterprise-reference",
    registry: "mentraenterpriseref",
    containerApp: "ca-mentra-enterprise-reference",
    coreContainerApp: "ca-mentra-ent-ref-core",
    workspaceOrigin: "https://demo.acmeworkspace.com",
  }),
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

// Container Apps generate `<app>.<environment-label>.<region>.azurecontainerapps.io`,
// for example ca-mentra-ent-ref-core.gentlehill-4ed63a4c.westus2.azurecontainerapps.io.
function coreHostnamePattern(target) {
  return new RegExp(
    `^${target.coreContainerApp.replaceAll("-", "\\-")}\\.[a-z0-9]+-[0-9a-f]{8}\\.[a-z0-9]+\\.azurecontainerapps\\.io$`,
  )
}

function requireCoreContainerAppOrigin(value, coreHostname, target) {
  const origin = requireHttps(value, "coreOrigin")
  const parsed = new URL(origin)
  if (typeof coreHostname !== "string" || !coreHostnamePattern(target).test(coreHostname)) {
    throw new Error("coreHostname must be the deployment's generated Azure Core Container App hostname")
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.port !== "" || parsed.hostname !== coreHostname) {
    throw new Error("coreOrigin must be the expected Azure Core Container App ingress")
  }
  return origin
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requireIsoUtc(value, label) {
  const parsed = new Date(value)
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`)
  }
  return value
}

// Returns the demo stack the plan's channel deploys.
function validatePlan(plan, sourceCommit) {
  if (
    plan?.schemaVersion !== 1 ||
    !Object.hasOwn(TARGETS, plan.channel) ||
    plan.releaseSetId !== `mentra-${plan.releaseIdentity}` ||
    plan.sourceCommit !== sourceCommit
  ) {
    throw new Error("Private Deployment inputs do not match a dev or beta release plan")
  }
  return TARGETS[plan.channel]
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
      throw new Error("Private Deployment contains an invalid readiness check")
    }
  }
  if (expected.size !== 0) throw new Error("Private Deployment checks are incomplete")
  return [...checks].sort((left, right) => left.url.localeCompare(right.url))
}

export function createPrivateDeploymentRecord({
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
  coreHostname,
  coreOrigin,
  checks,
  completedAt,
  provenanceUrl,
}) {
  const target = validatePlan(plan, sourceCommit)
  if (!COMMIT_PATTERN.test(requestedTag || "") || requestedTag !== sourceCommit) {
    throw new Error("requestedTag must equal the full sourceCommit")
  }
  if (!["deployed", "validated"].includes(status)) {
    throw new Error("Private Deployment status must be deployed or validated")
  }
  const record = {
    schemaVersion: 1,
    component: "private-deployment",
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    sourceCommit,
    channel: plan.channel,
    environment: target.environment,
    status,
    services: [...SERVICES],
    meetingProvider: MEETING_PROVIDER,
    azure: {
      resourceGroup: target.resourceGroup,
      registry: target.registry,
      containerApp: target.containerApp,
      coreContainerApp: target.coreContainerApp,
      imageRepository: IMAGE_REPOSITORY,
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
      throw new Error("Private Deployment is missing its canonical GHCR source")
    }
    const expectedImage = `${target.registry}.azurecr.io/${IMAGE_REPOSITORY}@${imageDigest}`
    if (
      image !== expectedImage ||
      !DIGEST_PATTERN.test(imageDigest || "") ||
      typeof revision !== "string" ||
      revision.length === 0 ||
      typeof coreRevision !== "string" ||
      coreRevision.length === 0
    ) {
      throw new Error("Private Deployment is missing immutable Azure image evidence")
    }
    const origin = requireHttps(workspaceOrigin, "workspaceOrigin")
    if (origin !== target.workspaceOrigin) {
      throw new Error("Private Deployment uses the wrong workspace origin")
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
    record.azure.coreHostname = requireNonEmptyString(coreHostname, "coreHostname")
    record.workspaceOrigin = origin
    record.coreOrigin = requireCoreContainerAppOrigin(coreOrigin, coreHostname, target)
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
    throw new Error("Private Deployment does not match the coordinated Mentra Cloud image")
  }
}

export function validatePrivateDeploymentRecord({plan, record, allowValidated = false, runtimeImage}) {
  const target = validatePlan(plan, record?.sourceCommit)
  if (
    record.schemaVersion !== 1 ||
    record.component !== "private-deployment" ||
    record.releaseSetId !== plan.releaseSetId ||
    record.releaseIdentity !== plan.releaseIdentity ||
    record.channel !== plan.channel ||
    record.environment !== target.environment ||
    JSON.stringify(record.services) !== JSON.stringify(SERVICES) ||
    record.meetingProvider !== MEETING_PROVIDER ||
    record.azure?.resourceGroup !== target.resourceGroup ||
    record.azure?.registry !== target.registry ||
    record.azure?.containerApp !== target.containerApp ||
    record.azure?.coreContainerApp !== target.coreContainerApp ||
    record.azure?.imageRepository !== IMAGE_REPOSITORY ||
    record.azure?.requestedTag !== plan.sourceCommit
  ) {
    throw new Error("Private Deployment record does not match the release plan and target")
  }
  requireIsoUtc(record.completedAt, "privateDeployment.completedAt")
  requireHttps(record.provenanceUrl, "privateDeployment.provenanceUrl")
  if (record.status === "validated") {
    if (
      record.azure.image !== undefined ||
      record.azure.imageDigest !== undefined ||
      record.azure.revision !== undefined ||
      record.azure.coreRevision !== undefined ||
      record.azure.coreHostname !== undefined ||
      record.source !== undefined ||
      record.workspaceOrigin !== undefined ||
      record.coreOrigin !== undefined ||
      record.checks !== undefined
    ) {
      throw new Error("Validation-only Private Deployment evidence must not claim a live deployment")
    }
    if (allowValidated) {
      assertCanonicalRuntimeImage(record, runtimeImage)
      return record
    }
  }
  if (record.status !== "deployed") throw new Error("Private Deployment record is not a completed deployment")
  if (record.source?.reference !== `${CANONICAL_IMAGE}@${record.source?.imageDigest}`) {
    throw new Error("Private Deployment canonical source reference is inconsistent")
  }
  const validated = createPrivateDeploymentRecord({
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
    coreHostname: record.azure.coreHostname,
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
  const record = createPrivateDeploymentRecord({
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
    coreHostname: args["core-hostname"],
    coreOrigin: args["core-origin"],
    checks: args.checks ? readJson(args.checks) : undefined,
    completedAt: args["completed-at"],
    provenanceUrl: args["provenance-url"],
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(record, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
