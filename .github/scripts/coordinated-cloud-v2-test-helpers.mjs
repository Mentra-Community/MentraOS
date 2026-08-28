import {resolveCloudV2Target} from "./coordinated-cloud-v2-records.mjs"

export function cloudRecordForPlan(plan) {
  const environment = {dev: "dev", beta: "staging", production: "prod"}[plan.channel]
  const target = resolveCloudV2Target({plan, environment, sourceCommit: plan.sourceCommit})
  return {
    schemaVersion: 1,
    component: "cloud-v2-core-store-runtime",
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
    deploymentId: "porter:revision-42",
    observedServices: ["core", "store", "runtime"].map((service, index) => ({
      service,
      digest: `sha256:${String(index + 1).repeat(64)}`,
      images: [`registry.example.com/cloud-v2:${plan.sourceCommit}`],
      porterRevision: "revision-42",
      podUids: [`${service}-pod-uid`],
      workloadUids: [`${service}-workload-uid`],
    })),
    checks: Object.entries(target.services)
      .flatMap(([service, definition]) =>
        definition.hosts.flatMap((host) =>
          ["healthz", "ready"].map((probe) => ({
            service,
            url: `https://${host}/${probe}`,
            ready: true,
            statusCode: 200,
          })),
        ),
      )
      .sort((left, right) => left.url.localeCompare(right.url)),
    completedAt: "2026-08-27T20:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
  }
}
