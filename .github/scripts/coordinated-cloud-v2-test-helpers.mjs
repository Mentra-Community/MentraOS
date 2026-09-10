import {resolveCloudV2Target} from "./coordinated-cloud-v2-records.mjs"

function readyChecks(services, probes) {
  return Object.entries(services)
    .flatMap(([service, definition]) =>
      definition.hosts.flatMap((host) =>
        probes.map((probe) => ({
          service,
          url: `https://${host}/${probe}`,
          ready: true,
          statusCode: 200,
        })),
      ),
    )
    .sort((left, right) => left.url.localeCompare(right.url))
}

function observedServices(services, imageName, sourceCommit) {
  return Object.keys(services).map((service, index) => ({
    service,
    digest: `sha256:${String(index + 1).repeat(64)}`,
    images: [`registry.example.com/${imageName}:${sourceCommit}`],
    porterRevision: "revision-42",
    podUids: [`${service}-pod-uid`],
    workloadUids: [`${service}-workload-uid`],
  }))
}

export function cloudRecordForPlan(plan) {
  const environment = {dev: "dev", beta: "staging", production: "prod"}[plan.channel]
  const target = resolveCloudV2Target({plan, environment, sourceCommit: plan.sourceCommit})
  return {
    schemaVersion: 1,
    component: "cloud-v2-core-runtime",
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    sourceCommit: plan.sourceCommit,
    channel: plan.channel,
    environment,
    status: "deployed",
    porter: {
      app: target.porterApp,
      config: target.porterConfig,
      cluster: target.porterCluster,
      project: target.porterProject,
      deploymentTargetId: target.porterDeploymentTargetId,
      target: target.porterTarget,
      requestedTag: plan.sourceCommit,
    },
    companions: Object.fromEntries(
      Object.entries(target.companions).map(([name, companion]) => [
        name,
        {
          porter: {
            app: companion.porterApp,
            config: companion.porterConfig,
            cluster: companion.porterCluster,
            project: companion.porterProject,
            deploymentTargetId: companion.porterDeploymentTargetId,
            target: companion.porterTarget,
            requestedTag: plan.sourceCommit,
          },
          deploymentId: "porter:revision-7",
          observedServices: observedServices(companion.services, name, plan.sourceCommit),
          checks: readyChecks(companion.services, companion.probes),
        },
      ]),
    ),
    deploymentId: "porter:revision-42",
    observedServices: observedServices(target.services, "cloud-v2", plan.sourceCommit),
    checks: readyChecks(target.services, ["healthz", "ready"]),
    completedAt: "2026-08-27T20:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
  }
}
