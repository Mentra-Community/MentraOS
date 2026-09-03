import {createRuntimeImageRecord} from "./coordinated-runtime-image-records.mjs"

export function runtimeImageRecordForPlan(plan, status = "published") {
  return createRuntimeImageRecord({
    plan,
    sourceCommit: plan.sourceCommit,
    status,
    digest: status === "published" ? `sha256:${"8".repeat(64)}` : undefined,
    sbom:
      status === "published"
        ? {
            format: "spdx-json",
            name: `mentra-runtime-${plan.releaseIdentity}.spdx.json`,
            sha256: "9".repeat(64),
            size: 4096,
            attestationUrl: "https://github.com/Mentra-Community/MentraOS/attestations/902",
          }
        : undefined,
    provenanceAttestationUrl:
      status === "published" ? "https://github.com/Mentra-Community/MentraOS/attestations/901" : undefined,
    completedAt: "2026-09-02T12:00:00.000Z",
    workflowUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/900",
  })
}
