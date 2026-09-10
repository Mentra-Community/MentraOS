import assert from "node:assert/strict"
import test from "node:test"

import {
  CLOUD_V2_TARGETS,
  createCloudV2DeploymentRecord,
  resolveCloudV2Target,
  validateCloudV2DeploymentRecord,
} from "./coordinated-cloud-v2-records.mjs"

const sourceCommit = "a".repeat(40)
const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"

function plan(channel, identity) {
  return {
    schemaVersion: 1,
    releaseSetId: `mentra-${identity}`,
    releaseIdentity: identity,
    channel,
    sourceCommit,
  }
}

function planFor(environment) {
  return environment === "dev"
    ? plan("dev", "3.1.0-dev.1")
    : environment === "staging"
      ? plan("beta", "3.1.0-beta.1")
      : plan("production", "3.1.0")
}

function pods(services = ["core", "runtime"], image = "cloud-v2", revision = "revision-42") {
  return {
    apiVersion: "v1",
    kind: "PodList",
    items: services.map((service) => ({
      metadata: {
        name: `${image}-${service}-abc`,
        uid: `${service}-pod-uid`,
        labels: {"porter.run/service-name": service},
        ownerReferences: [{uid: `${service}-workload-uid`}],
      },
      spec: {
        containers: [{name: service, env: [{name: "PORTER_POD_REVISION", value: revision}]}],
      },
      status: {
        phase: "Running",
        conditions: [{type: "Ready", status: "True"}],
        containerStatuses: [
          {
            name: service,
            ready: true,
            image: `registry.example.com/${image}:${sourceCommit}`,
            imageID: `docker-pullable://registry.example.com/${image}@sha256:${"b".repeat(64)}`,
          },
        ],
      },
    })),
  }
}

function checksFor(services, probes) {
  return Object.entries(services).flatMap(([service, definition]) =>
    definition.hosts.flatMap((host) =>
      probes.map((probe) => ({
        service,
        url: `https://${host}/${probe}`,
        ready: true,
        statusCode: 200,
      })),
    ),
  )
}

function checks(environment) {
  const target = resolveCloudV2Target({plan: planFor(environment), environment, sourceCommit})
  return checksFor(target.services, ["healthz", "ready"])
}

function companions(environment) {
  const target = resolveCloudV2Target({plan: planFor(environment), environment, sourceCommit})
  return Object.fromEntries(
    Object.entries(target.companions).map(([name, companion]) => [
      name,
      {
        pods: pods(Object.keys(companion.services), name, "revision-7"),
        checks: checksFor(companion.services, companion.probes),
      },
    ]),
  )
}

function deployedRecord(environment, overrides = {}) {
  return createCloudV2DeploymentRecord({
    plan: planFor(environment),
    environment,
    sourceCommit,
    requestedTag: sourceCommit,
    status: "deployed",
    pods: pods(),
    checks: checks(environment),
    companions: companions(environment),
    completedAt: "2026-08-27T20:00:00.000Z",
    provenanceUrl,
    ...overrides,
  })
}

test("resolves the existing branch-associated Cloud V2 targets", () => {
  assert.equal(
    resolveCloudV2Target({plan: plan("dev", "3.1.0-dev.1"), environment: "dev", sourceCommit}).porterApp,
    "cloud-dev",
  )
  assert.equal(
    resolveCloudV2Target({plan: plan("beta", "3.1.0-beta.1"), environment: "staging", sourceCommit}).porterConfig,
    "cloud-v2/porter.staging.yaml",
  )
  assert.equal(
    resolveCloudV2Target({plan: plan("production", "3.1.0"), environment: "prod", sourceCommit}).porterApp,
    "cloud-prod",
  )
})

test("every environment resolves the Merge server as a companion Porter app", () => {
  const expected = {
    dev: ["merge-dev", "miniapps/merge/porter.dev.yaml", "merge3.dev.mentraglass.com"],
    staging: ["merge-staging", "miniapps/merge/porter.staging.yaml", "merge3.staging.mentraglass.com"],
    prod: ["merge-prod", "miniapps/merge/porter.prod.yaml", "merge3.mentraglass.com"],
  }
  for (const [environment, [app, config, host]] of Object.entries(expected)) {
    const target = resolveCloudV2Target({plan: planFor(environment), environment, sourceCommit})
    assert.deepEqual(Object.keys(target.companions), ["merge"])
    assert.equal(target.companions.merge.porterApp, app)
    assert.equal(target.companions.merge.porterConfig, config)
    assert.equal(target.companions.merge.porterProject, target.porterProject)
    assert.deepEqual(target.companions.merge.probes, ["healthz"])
    assert.deepEqual(target.companions.merge.services, {backend: {hosts: [host]}})
    // Resolved targets are copies; the frozen table cannot be mutated through them.
    assert.ok(Object.isFrozen(CLOUD_V2_TARGETS[environment].companions.merge))
  }
})

test("rejects a release channel targeting another cloud", () => {
  assert.throws(
    () => resolveCloudV2Target({plan: plan("beta", "3.1.0-beta.1"), environment: "prod", sourceCommit}),
    /cannot deploy Cloud V2 prod/,
  )
  assert.throws(
    () => resolveCloudV2Target({plan: plan("dev", "3.1.0-dev.1"), environment: "unknown", sourceCommit}),
    /Unsupported Cloud V2 environment/,
  )
})

test("records observed image digests, Porter revision, and every public readiness probe", () => {
  const releasePlan = plan("beta", "3.1.0-beta.1")
  const record = deployedRecord("staging")
  assert.equal(record.deploymentId, "porter:revision-42")
  assert.deepEqual(
    record.observedServices.map((service) => service.service),
    ["core", "runtime"],
  )
  assert.equal(record.observedServices[0].digest, `sha256:${"b".repeat(64)}`)
  assert.equal(record.checks.length, 4)
  assert.equal(validateCloudV2DeploymentRecord({plan: releasePlan, record}), record)
})

test("records companion app evidence from the same source tag alongside Core and Runtime", () => {
  const record = deployedRecord("prod")
  assert.deepEqual(Object.keys(record.companions), ["merge"])
  const merge = record.companions.merge
  assert.deepEqual(merge.porter, {
    app: "merge-prod",
    config: "miniapps/merge/porter.prod.yaml",
    cluster: "5783",
    project: "15081",
    deploymentTargetId: "95380467-4a76-458d-b12a-df66cf0c362b",
    target: "miniapps-us-west-2-default",
    requestedTag: sourceCommit,
  })
  assert.equal(merge.deploymentId, "porter:revision-7")
  assert.deepEqual(
    merge.observedServices.map((service) => service.service),
    ["backend"],
  )
  assert.deepEqual(
    merge.checks.map((check) => check.url),
    ["https://merge3.mentraglass.com/healthz"],
  )
  assert.equal(validateCloudV2DeploymentRecord({plan: planFor("prod"), record}), record)
})

test("fails closed when a companion app is unobserved, stale, or missing from the record", () => {
  assert.throws(() => deployedRecord("dev", {companions: {}}), /Companion app merge has no observed pods/)
  assert.throws(() => deployedRecord("dev", {companions: undefined}), /Companion app merge has no observed pods/)

  const stale = companions("dev")
  stale.merge.pods.items[0].status.containerStatuses[0].image = `registry.example.com/merge:${"c".repeat(40)}`
  assert.throws(
    () => deployedRecord("dev", {companions: stale}),
    /companion merge backend image does not use requested source tag/,
  )

  const unprobed = companions("dev")
  unprobed.merge.checks = []
  assert.throws(() => deployedRecord("dev", {companions: unprobed}), /missing or duplicated/)

  const record = deployedRecord("dev")
  const {companions: _dropped, ...withoutCompanions} = record
  assert.throws(
    () => validateCloudV2DeploymentRecord({plan: planFor("dev"), record: withoutCompanions}),
    /must describe companion apps merge/,
  )
  const foreign = structuredClone(record)
  foreign.companions.merge.porter.app = "merge-prod"
  assert.throws(
    () => validateCloudV2DeploymentRecord({plan: planFor("dev"), record: foreign}),
    /Companion app merge record does not match/,
  )
  const unready = structuredClone(record)
  unready.companions.merge.observedServices = []
  assert.throws(
    () => validateCloudV2DeploymentRecord({plan: planFor("dev"), record: unready}),
    /Companion app merge deployment record must observe backend/,
  )
})

test("fails closed on unready pods, mutable image observations, and missing public checks", () => {
  const unready = pods()
  unready.items[0].status.conditions[0].status = "False"
  assert.throws(() => deployedRecord("dev", {pods: unready}), /is not ready/)

  const mutable = pods()
  mutable.items[0].status.containerStatuses[0].imageID = `registry.example.com/cloud-v2:${sourceCommit}`
  assert.throws(() => deployedRecord("dev", {pods: mutable}), /does not contain an immutable digest/)

  const wrongSource = pods()
  wrongSource.items[1].status.containerStatuses[0].image = `registry.example.com/cloud-v2:${"b".repeat(40)}`
  assert.throws(() => deployedRecord("dev", {pods: wrongSource}), /does not use requested source tag/)

  assert.throws(() => deployedRecord("dev", {checks: checks("dev").slice(1)}), /missing or duplicated/)
})

test("dry-run evidence is validation-only and cannot finalize a live release", () => {
  const releasePlan = plan("dev", "3.1.0-dev.1")
  const record = createCloudV2DeploymentRecord({
    plan: releasePlan,
    environment: "dev",
    sourceCommit,
    requestedTag: sourceCommit,
    status: "validated",
    completedAt: "2026-08-27T20:00:00.000Z",
    provenanceUrl,
  })
  assert.deepEqual(Object.keys(record.companions.merge), ["porter"])
  assert.equal(validateCloudV2DeploymentRecord({plan: releasePlan, record, allowValidated: true}), record)
  assert.throws(() => validateCloudV2DeploymentRecord({plan: releasePlan, record}), /not a completed deployment/)
  assert.throws(
    () =>
      validateCloudV2DeploymentRecord({
        plan: releasePlan,
        record: {...record, deploymentId: "porter:fake"},
        allowValidated: true,
      }),
    /must not claim a deployed or ready environment/,
  )
  const claimed = structuredClone(record)
  claimed.companions.merge.deploymentId = "porter:fake"
  assert.throws(
    () => validateCloudV2DeploymentRecord({plan: releasePlan, record: claimed, allowValidated: true}),
    /Validation-only companion app merge evidence must not claim a deployed environment/,
  )
})
