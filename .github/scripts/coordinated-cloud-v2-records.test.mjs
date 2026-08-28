import assert from "node:assert/strict"
import test from "node:test"

import {
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

function pods() {
  return {
    apiVersion: "v1",
    kind: "PodList",
    items: ["core", "store", "runtime"].map((service) => ({
      metadata: {
        name: `cloud-${service}-abc`,
        uid: `${service}-pod-uid`,
        labels: {"porter.run/service-name": service},
        ownerReferences: [{uid: `${service}-workload-uid`}],
      },
      spec: {
        containers: [{name: service, env: [{name: "PORTER_POD_REVISION", value: "revision-42"}]}],
      },
      status: {
        phase: "Running",
        conditions: [{type: "Ready", status: "True"}],
        containerStatuses: [
          {
            name: service,
            ready: true,
            image: `registry.example.com/cloud-v2:${sourceCommit}`,
            imageID: `docker-pullable://registry.example.com/cloud-v2@sha256:${"b".repeat(64)}`,
          },
        ],
      },
    })),
  }
}

function checks(environment) {
  const target = resolveCloudV2Target({
    plan:
      environment === "dev"
        ? plan("dev", "3.1.0-dev.1")
        : environment === "staging"
          ? plan("beta", "3.1.0-beta.1")
          : plan("production", "3.1.0"),
    environment,
    sourceCommit,
  })
  return Object.entries(target.services).flatMap(([service, definition]) =>
    definition.hosts.flatMap((host) =>
      ["healthz", "ready"].map((probe) => ({
        service,
        url: `https://${host}/${probe}`,
        ready: true,
        statusCode: 200,
      })),
    ),
  )
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
  const record = createCloudV2DeploymentRecord({
    plan: releasePlan,
    environment: "staging",
    sourceCommit,
    requestedTag: sourceCommit,
    status: "deployed",
    pods: pods(),
    checks: checks("staging"),
    completedAt: "2026-08-27T20:00:00.000Z",
    provenanceUrl,
  })
  assert.equal(record.deploymentId, "porter:revision-42")
  assert.deepEqual(
    record.observedServices.map((service) => service.service),
    ["core", "store", "runtime"],
  )
  assert.equal(record.observedServices[0].digest, `sha256:${"b".repeat(64)}`)
  assert.equal(record.checks.length, 6)
  assert.equal(validateCloudV2DeploymentRecord({plan: releasePlan, record}), record)
})

test("fails closed on unready pods, mutable image observations, and missing public checks", () => {
  const releasePlan = plan("dev", "3.1.0-dev.1")
  const unready = pods()
  unready.items[0].status.conditions[0].status = "False"
  assert.throws(
    () =>
      createCloudV2DeploymentRecord({
        plan: releasePlan,
        environment: "dev",
        sourceCommit,
        requestedTag: sourceCommit,
        status: "deployed",
        pods: unready,
        checks: checks("dev"),
        completedAt: "2026-08-27T20:00:00.000Z",
        provenanceUrl,
      }),
    /is not ready/,
  )

  const mutable = pods()
  mutable.items[0].status.containerStatuses[0].imageID = `registry.example.com/cloud-v2:${sourceCommit}`
  assert.throws(
    () =>
      createCloudV2DeploymentRecord({
        plan: releasePlan,
        environment: "dev",
        sourceCommit,
        requestedTag: sourceCommit,
        status: "deployed",
        pods: mutable,
        checks: checks("dev"),
        completedAt: "2026-08-27T20:00:00.000Z",
        provenanceUrl,
      }),
    /does not contain an immutable digest/,
  )

  const wrongSource = pods()
  wrongSource.items[1].status.containerStatuses[0].image = `registry.example.com/cloud-v2:${"b".repeat(40)}`
  assert.throws(
    () =>
      createCloudV2DeploymentRecord({
        plan: releasePlan,
        environment: "dev",
        sourceCommit,
        requestedTag: sourceCommit,
        status: "deployed",
        pods: wrongSource,
        checks: checks("dev"),
        completedAt: "2026-08-27T20:00:00.000Z",
        provenanceUrl,
      }),
    /does not use requested source tag/,
  )

  assert.throws(
    () =>
      createCloudV2DeploymentRecord({
        plan: releasePlan,
        environment: "dev",
        sourceCommit,
        requestedTag: sourceCommit,
        status: "deployed",
        pods: pods(),
        checks: checks("dev").slice(1),
        completedAt: "2026-08-27T20:00:00.000Z",
        provenanceUrl,
      }),
    /missing or duplicated/,
  )
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
})
