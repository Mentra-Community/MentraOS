#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const CLOUD_V2_SERVICES = Object.freeze(["core", "store", "runtime"])

export const CLOUD_V2_TARGETS = Object.freeze({
  dev: Object.freeze({
    channel: "dev",
    porterApp: "cloud-dev",
    porterConfig: "cloud-v2/porter.dev.yaml",
    porterCluster: "5692",
    porterProject: "15081",
    porterDeploymentTargetId: "87f939d6-b019-4955-9f4b-1050e8ff57bd",
    porterTarget: "aws-us-west-2-default",
    services: Object.freeze({
      core: Object.freeze(["core.dev.us-west-2.mentraglass.com"]),
      store: Object.freeze(["store.dev.us-west-2.mentraglass.com"]),
      runtime: Object.freeze(["runtime.dev.us-west-2.mentraglass.com"]),
    }),
  }),
  staging: Object.freeze({
    channel: "beta",
    porterApp: "cloud-staging",
    porterConfig: "cloud-v2/porter.staging.yaml",
    porterCluster: "5692",
    porterProject: "15081",
    porterDeploymentTargetId: "87f939d6-b019-4955-9f4b-1050e8ff57bd",
    porterTarget: "aws-us-west-2-default",
    services: Object.freeze({
      core: Object.freeze(["core.staging.us-west-2.mentraglass.com"]),
      store: Object.freeze(["store.staging.us-west-2.mentraglass.com"]),
      runtime: Object.freeze(["runtime.staging.us-west-2.mentraglass.com"]),
    }),
  }),
  prod: Object.freeze({
    channel: "production",
    porterApp: "cloud-prod",
    porterConfig: "cloud-v2/porter.prod.yaml",
    porterCluster: "5692",
    porterProject: "15081",
    porterDeploymentTargetId: "87f939d6-b019-4955-9f4b-1050e8ff57bd",
    porterTarget: "aws-us-west-2-default",
    services: Object.freeze({
      core: Object.freeze(["core.us-west-2.mentraglass.com", "core.mentraglass.com"]),
      store: Object.freeze(["store.us-west-2.mentraglass.com", "store.mentraglass.com"]),
      runtime: Object.freeze(["runtime.us-west-2.mentraglass.com", "runtime.mentraglass.com"]),
    }),
  }),
})

function requirePublicHttps(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`)
  }
  return parsed.toString()
}

function requireIsoUtc(value, label) {
  const parsed = new Date(value)
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`)
  }
  return value
}

function expectedChecks(target) {
  return Object.entries(target.services)
    .flatMap(([service, definition]) =>
      (Array.isArray(definition) ? definition : definition.hosts).flatMap((host) =>
        ["healthz", "ready"].map((probe) => ({service, url: `https://${host}/${probe}`})),
      ),
    )
    .sort((left, right) => left.url.localeCompare(right.url))
}

export function resolveCloudV2Target({plan, environment, sourceCommit}) {
  const target = CLOUD_V2_TARGETS[environment]
  if (!target) throw new Error(`Unsupported Cloud V2 environment ${JSON.stringify(environment)}`)
  if (!COMMIT_PATTERN.test(sourceCommit || "")) throw new Error("sourceCommit must be a full lowercase Git SHA")
  if (
    plan?.schemaVersion !== 1 ||
    plan.releaseSetId !== `mentra-${plan.releaseIdentity}` ||
    plan.sourceCommit !== sourceCommit
  ) {
    throw new Error("Cloud V2 deployment inputs do not match the release plan")
  }
  if (plan.channel !== target.channel) {
    throw new Error(`Release channel ${JSON.stringify(plan.channel)} cannot deploy Cloud V2 ${environment}`)
  }
  return {
    environment,
    channel: target.channel,
    porterApp: target.porterApp,
    porterConfig: target.porterConfig,
    porterCluster: target.porterCluster,
    porterProject: target.porterProject,
    porterDeploymentTargetId: target.porterDeploymentTargetId,
    porterTarget: target.porterTarget,
    services: Object.fromEntries(
      Object.entries(target.services).map(([service, hosts]) => [service, {hosts: [...hosts]}]),
    ),
  }
}

function envValue(pod, name) {
  for (const container of pod.spec?.containers || []) {
    const value = (container.env || []).find((entry) => entry.name === name)?.value
    if (value) return value
  }
  return undefined
}

function observedPodRevision(pod) {
  const injected = envValue(pod, "PORTER_POD_REVISION")
  if (injected) return injected
  for (const metadata of [pod.metadata?.labels, pod.metadata?.annotations]) {
    for (const [key, value] of Object.entries(metadata || {})) {
      if (/porter.*revision/i.test(key) && value) return value
    }
  }
  return undefined
}

function observeServices(pods) {
  if (!Array.isArray(pods?.items)) throw new Error("Observed Kubernetes pods must be a PodList")
  const active = pods.items.filter(
    (pod) => !pod.metadata?.deletionTimestamp && !["Failed", "Succeeded"].includes(pod.status?.phase),
  )
  const observed = []
  for (const service of CLOUD_V2_SERVICES) {
    const servicePods = active.filter((pod) => pod.metadata?.labels?.["porter.run/service-name"] === service)
    if (servicePods.length === 0) throw new Error(`No active ${service} pods were observed`)
    const digests = new Set()
    const images = new Set()
    const revisions = new Set()
    const podUids = []
    const workloadUids = []
    for (const pod of servicePods) {
      const ready = (pod.status?.conditions || []).some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      )
      if (!ready) throw new Error(`Observed ${service} pod ${pod.metadata?.name || "<unknown>"} is not ready`)
      const statuses = (pod.status?.containerStatuses || []).filter((status) => status.ready && status.imageID)
      if (statuses.length === 0) throw new Error(`Observed ${service} pod has no ready image identity`)
      for (const status of statuses) {
        const match = status.imageID.match(/@?(sha256:[0-9a-f]{64})$/)
        if (!match) throw new Error(`Observed ${service} imageID does not contain an immutable digest`)
        digests.add(match[1])
        if (status.image) images.add(status.image)
      }
      const revision = observedPodRevision(pod)
      if (revision) revisions.add(revision)
      if (pod.metadata?.uid) podUids.push(pod.metadata.uid)
      for (const owner of pod.metadata?.ownerReferences || []) {
        if (owner.uid) workloadUids.push(owner.uid)
      }
    }
    if (digests.size !== 1) throw new Error(`Observed ${service} pods do not run one immutable image digest`)
    if (revisions.size > 1) throw new Error(`Observed ${service} pods span multiple Porter revisions`)
    observed.push({
      service,
      digest: [...digests][0],
      images: [...images].sort(),
      porterRevision: [...revisions][0] || null,
      podUids: [...new Set(podUids)].sort(),
      workloadUids: [...new Set(workloadUids)].sort(),
    })
  }
  return observed
}

function deploymentId(observedServices) {
  const revisions = new Set(observedServices.map((service) => service.porterRevision).filter(Boolean))
  if (revisions.size === 1) return `porter:${[...revisions][0]}`
  const workloadIdentity = observedServices.flatMap((service) =>
    service.workloadUids.map((uid) => `${service.service}:${uid}`),
  )
  if (workloadIdentity.length === 0) {
    throw new Error("Observed deployment has neither a Porter revision nor Kubernetes workload UIDs")
  }
  const digest = createHash("sha256").update(workloadIdentity.sort().join("\n")).digest("hex")
  return `kubernetes-sha256:${digest}`
}

function validateChecks(target, checks) {
  if (!Array.isArray(checks)) throw new Error("Cloud V2 deployment checks must be an array")
  const expected = expectedChecks(target)
  const byUrl = new Map(checks.map((check) => [check.url, check]))
  if (byUrl.size !== checks.length || checks.length !== expected.length) {
    throw new Error("Cloud V2 deployment checks are missing or duplicated")
  }
  for (const item of expected) {
    const check = byUrl.get(item.url)
    if (
      !check ||
      check.service !== item.service ||
      check.ready !== true ||
      !Number.isInteger(check.statusCode) ||
      check.statusCode < 200 ||
      check.statusCode >= 300
    ) {
      throw new Error(`Cloud V2 deployment check failed for ${item.url}`)
    }
  }
  return checks
    .map((check) => ({
      service: check.service,
      url: requirePublicHttps(check.url, "checks.url"),
      ready: true,
      statusCode: check.statusCode,
    }))
    .sort((left, right) => left.url.localeCompare(right.url))
}

export function createCloudV2DeploymentRecord({
  plan,
  environment,
  sourceCommit,
  requestedTag,
  status,
  pods,
  checks,
  completedAt,
  provenanceUrl,
}) {
  const target = resolveCloudV2Target({plan, environment, sourceCommit})
  if (!COMMIT_PATTERN.test(requestedTag || "") || requestedTag !== sourceCommit) {
    throw new Error("requestedTag must equal the full sourceCommit")
  }
  if (!new Set(["deployed", "validated"]).has(status)) {
    throw new Error("Cloud V2 deployment status must be deployed or validated")
  }
  const record = {
    schemaVersion: 1,
    component: "cloud-v2-core-store-runtime",
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    sourceCommit,
    channel: plan.channel,
    environment,
    status,
    porter: {
      app: target.porterApp,
      config: target.porterConfig,
      cluster: target.porterCluster,
      project: target.porterProject,
      deploymentTargetId: target.porterDeploymentTargetId,
      target: target.porterTarget,
      requestedTag,
    },
    completedAt: requireIsoUtc(completedAt, "completedAt"),
    provenanceUrl: requirePublicHttps(provenanceUrl, "provenanceUrl"),
  }
  if (status === "deployed") {
    const observedServices = observeServices(pods)
    for (const observed of observedServices) {
      if (!observed.images.some((image) => image.endsWith(`:${requestedTag}`))) {
        throw new Error(`Observed ${observed.service} image does not use requested source tag ${requestedTag}`)
      }
    }
    record.deploymentId = deploymentId(observedServices)
    record.observedServices = observedServices
    record.checks = validateChecks(target, checks)
  }
  return record
}

export function validateCloudV2DeploymentRecord({plan, record, allowValidated = false}) {
  const target = resolveCloudV2Target({plan, environment: record?.environment, sourceCommit: record?.sourceCommit})
  if (
    record.schemaVersion !== 1 ||
    record.component !== "cloud-v2-core-store-runtime" ||
    record.releaseSetId !== plan.releaseSetId ||
    record.releaseIdentity !== plan.releaseIdentity ||
    record.channel !== plan.channel ||
    record.porter?.app !== target.porterApp ||
    record.porter?.config !== target.porterConfig ||
    record.porter?.cluster !== target.porterCluster ||
    record.porter?.project !== target.porterProject ||
    record.porter?.deploymentTargetId !== target.porterDeploymentTargetId ||
    record.porter?.target !== target.porterTarget
  ) {
    throw new Error("Cloud V2 deployment record does not match the release plan and target")
  }
  if (!COMMIT_PATTERN.test(record.porter.requestedTag || "") || record.porter.requestedTag !== plan.sourceCommit) {
    throw new Error("Cloud V2 deployment record has an invalid requested tag")
  }
  requireIsoUtc(record.completedAt, "cloud.completedAt")
  requirePublicHttps(record.provenanceUrl, "cloud.provenanceUrl")
  if (record.status === "validated") {
    if (record.deploymentId !== undefined || record.observedServices !== undefined || record.checks !== undefined) {
      throw new Error("Validation-only Cloud V2 evidence must not claim a deployed or ready environment")
    }
    if (allowValidated) return record
  }
  if (record.status !== "deployed") throw new Error("Cloud V2 deployment record is not a completed deployment")
  if (typeof record.deploymentId !== "string" || record.deploymentId.length === 0) {
    throw new Error("Cloud V2 deployment record is missing its observed deployment identity")
  }
  if (!Array.isArray(record.observedServices) || record.observedServices.length !== CLOUD_V2_SERVICES.length) {
    throw new Error("Cloud V2 deployment record must observe Core, Store, and Runtime")
  }
  const services = new Set()
  for (const observed of record.observedServices) {
    if (!new Set(CLOUD_V2_SERVICES).has(observed.service) || services.has(observed.service)) {
      throw new Error("Cloud V2 deployment record contains invalid observed services")
    }
    services.add(observed.service)
    if (!DIGEST_PATTERN.test(observed.digest || "")) {
      throw new Error(`Cloud V2 ${observed.service} is missing an immutable image digest`)
    }
    if (
      !Array.isArray(observed.images) ||
      !observed.images.some((image) => image.endsWith(`:${record.porter.requestedTag}`))
    ) {
      throw new Error(`Cloud V2 ${observed.service} does not identify the requested source tag`)
    }
  }
  validateChecks(target, record.checks)
  return record
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

function writeGithubOutputs(file, target) {
  if (!file) return
  const values = {
    environment: target.environment,
    porter_app: target.porterApp,
    porter_config: target.porterConfig,
    porter_cluster: target.porterCluster,
    porter_project: target.porterProject,
    porter_deployment_target_id: target.porterDeploymentTargetId,
    porter_target: target.porterTarget,
  }
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    {flag: "a"},
  )
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const plan = readJson(args.plan)
  if (command === "resolve") {
    const target = resolveCloudV2Target({
      plan,
      environment: args.environment,
      sourceCommit: args["source-commit"],
    })
    writeFileSync(path.resolve(args.output), `${JSON.stringify(target, null, 2)}\n`)
    writeGithubOutputs(args["github-output"], target)
    return
  }
  if (command === "create") {
    const status = args.status
    const record = createCloudV2DeploymentRecord({
      plan,
      environment: args.environment,
      sourceCommit: args["source-commit"],
      requestedTag: args["requested-tag"],
      status,
      pods: status === "deployed" ? readJson(args.pods) : undefined,
      checks: status === "deployed" ? readJson(args.checks) : undefined,
      completedAt: args["completed-at"],
      provenanceUrl: args["provenance-url"],
    })
    writeFileSync(path.resolve(args.output), `${JSON.stringify(record, null, 2)}\n`)
    return
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
