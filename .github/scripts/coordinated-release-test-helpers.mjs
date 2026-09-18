import {createReleasePlan, familyBuildNumber, finalizeReleaseManifest, loadReleaseFamily} from "./release-family.mjs"
import {cloudRecordForPlan} from "./coordinated-cloud-v2-test-helpers.mjs"
import {runtimeImageRecordForPlan} from "./coordinated-runtime-image-test-helpers.mjs"

const repository = "Mentra-Community/MentraOS"

export function finalizedBeta() {
  const family = loadReleaseFamily({rootDir: new URL("../../", import.meta.url).pathname})
  const plan = createReleasePlan({
    family,
    channel: "beta",
    sequence: 265,
    sourceCommit: "a".repeat(40),
    nativeBuildNumber: familyBuildNumber(family.familyBaseVersion, 57),
  })
  const publication = (coordinate) => ({
    status: "published",
    coordinate,
    url: `https://artifacts.example.com/${encodeURIComponent(coordinate)}`,
    sha256: "b".repeat(64),
    provenanceUrl: `https://github.com/${repository}/actions/runs/123`,
  })
  const coordinates = {
    "npm": (name) => `${name}@${plan.releaseIdentity}`,
    "maven-central": () => `com.mentraglass:bluetooth-sdk:${plan.releaseIdentity}`,
    "swift-package-manager": () => `Mentra-Community/mentra-bluetooth-sdk-ios@${plan.releaseIdentity}`,
    "google-play": () => `com.mentra.mentra:${plan.native.buildNumber}:internal-app-sharing`,
    "app-store-connect": () =>
      `com.mentra.mentra:${plan.native.marketingVersion}:${plan.native.buildNumber}:Mentra Staging`,
  }
  const results = {
    releaseSetId: plan.releaseSetId,
    cloud: cloudRecordForPlan(plan),
    runtimeImage: runtimeImageRecordForPlan(plan),
    publications: Object.fromEntries(
      Object.entries(plan.members).map(([name, member]) => [
        name,
        Object.fromEntries(member.publishTargets.map((target) => [target, publication(coordinates[target](name))])),
      ]),
    ),
    otaManifest: {
      ...publication(plan.artifactNames.otaManifest),
      url: `https://github.com/${repository}/releases/download/${plan.artifactContainerTag}/${plan.artifactNames.otaManifest}`,
    },
    artifacts: ["asgSelection", "otaBundle", "androidApp", "androidStoreApp", "iosApp", "enginePackage"].map((key) =>
      publication(plan.artifactNames[key]),
    ),
  }
  const manifest = finalizeReleaseManifest({plan, results, completedAt: "2026-09-17T04:10:53.000Z"})
  return {
    plan,
    manifest,
    run: {head_sha: plan.sourceCommit},
    repository,
    selection: {
      identity: plan.releaseIdentity,
      channel: "beta",
      planName: `coordinated-release-plan-${plan.releaseSetId}`,
    },
  }
}
