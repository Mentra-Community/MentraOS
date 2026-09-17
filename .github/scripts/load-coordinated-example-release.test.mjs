import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"

import {selectCoreReleaseArtifacts, validateCoreReleaseHandoff} from "./load-coordinated-example-release.mjs"
import {createReleasePlan, familyBuildNumber, finalizeReleaseManifest, loadReleaseFamily} from "./release-family.mjs"
import {cloudRecordForPlan} from "./coordinated-cloud-v2-test-helpers.mjs"
import {runtimeImageRecordForPlan} from "./coordinated-runtime-image-test-helpers.mjs"

const repository = "Mentra-Community/MentraOS"
function coreRun(branch = "dev") {
  const identity = `3.2.0-${branch === "dev" ? "dev" : "beta"}.265`
  return {
    repository,
    branch,
    runId: "123",
    run: {
      id: 123,
      repository: {full_name: repository},
      path: ".github/workflows/coordinated-release.yml",
      event: "push",
      head_branch: branch,
      head_sha: "a".repeat(40),
      conclusion: "failure",
    },
    jobs: [{name: "Finalize immutable release bill of materials", conclusion: "success"}],
    artifacts: [
      {name: `coordinated-release-plan-mentra-${identity}`, expired: false},
      {name: `coordinated-release-result-mentra-${identity}`, expired: false},
    ],
  }
}

test("selects an exact finalized core release even if its old example jobs failed", () => {
  for (const branch of ["dev", "staging"]) {
    const input = coreRun(branch)
    assert.equal(selectCoreReleaseArtifacts(input).channel, branch === "dev" ? "dev" : "beta")
    input.run.conclusion = null // the new core is still dispatching/notifying
    assert.equal(selectCoreReleaseArtifacts(input).planName, input.artifacts[0].name)
  }
})

test("rejects another workflow, repository, source branch, PR event, or run ID", () => {
  for (const change of [
    {path: ".github/workflows/other.yml"},
    {repository: {full_name: "attacker/repo"}},
    {head_branch: "staging"},
    {event: "pull_request"},
    {id: 999},
    {head_sha: "invalid"},
  ]) {
    const input = coreRun()
    assert.throws(() => selectCoreReleaseArtifacts({...input, run: {...input.run, ...change}}))
  }
  assert.throws(() => selectCoreReleaseArtifacts({...coreRun(), runId: "123/../../456"}))
  assert.throws(() => selectCoreReleaseArtifacts({...coreRun(), branch: "main"}))
})

test("rejects failed finalization and missing, expired, duplicate, or wrong-channel artifacts", () => {
  for (const conclusion of [null, "failure", "cancelled", "skipped"]) {
    const input = coreRun()
    input.jobs[0].conclusion = conclusion
    assert.throws(() => selectCoreReleaseArtifacts(input), /finalization/)
  }
  for (const mutate of [
    (a) => a.pop(),
    (a) => a.shift(),
    (a) => {
      a[0].expired = true
    },
    (a) => {
      a[1].expired = true
    },
    (a) => a.push({...a[0]}),
    (a) => a.push({...a[1]}),
    (a) => {
      a[0].name = a[0].name.replace("dev", "beta")
    },
  ]) {
    const input = coreRun()
    mutate(input.artifacts)
    assert.throws(() => selectCoreReleaseArtifacts(input))
  }
})

function finalizedBeta() {
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
    run: coreRun("staging").run,
    repository,
    selection: {
      identity: plan.releaseIdentity,
      channel: "beta",
      planName: `coordinated-release-plan-${plan.releaseSetId}`,
    },
  }
}

test("restores destinations and OTA identity from the complete immutable core evidence", () => {
  const input = finalizedBeta()
  const outputs = validateCoreReleaseHandoff(input)
  assert.equal(outputs.source_commit, input.run.head_sha)
  assert.equal(outputs.manifest_sha256, input.manifest.otaManifest.sha256)
  assert.equal(outputs.example_testflight_group, "Mentra Staging Public")
  assert.equal(outputs.example_play_track, "beta")
})

test("rejects mismatched identity, changed plan, incomplete closure, or substituted manifest", () => {
  for (const mutate of [
    (v) => {
      v.plan.sourceCommit = "f".repeat(40)
    },
    (v) => {
      v.plan.releaseIdentity = "3.2.0-beta.266"
    },
    (v) => {
      v.plan.native.buildNumber += 1
    },
    (v) => {
      v.manifest.sourceCommit = "f".repeat(40)
    },
    (v) => {
      v.manifest.releasePlanSha256 = "0".repeat(64)
    },
    (v) => {
      delete v.manifest.publications["@mentra/engine"]
    },
    (v) => {
      v.manifest.artifacts.pop()
    },
    (v) => {
      v.manifest.otaManifest.url = "https://example.com/other.json"
    },
  ]) {
    const input = finalizedBeta()
    mutate(input)
    assert.throws(() => validateCoreReleaseHandoff(input))
  }
})

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
}
function jobs(source) {
  return Object.fromEntries(
    [...source.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  )
}
function dependencies(job) {
  return (
    job
      .match(/^    needs: (.+)$/m)?.[1]
      .replace(/[\[\]]/g, "")
      .split(/,\s*/)
      .map((s) => s.trim()) || []
  )
}

test("core releases and notifications never wait for example builds or stores", () => {
  const core = workflow("coordinated-release.yml")
  const example = workflow("coordinated-example-release.yml")
  const graph = jobs(core)
  for (const name of ["starter-kit", "example-testflight", "example-google-play", "finalize-example", "docs"]) {
    assert.equal(graph[name], undefined)
  }
  assert.deepEqual(dependencies(graph["dispatch-examples"]), ["plan", "finalize"])
  assert.match(graph["dispatch-examples"], /actions: write/)
  assert.match(graph["dispatch-examples"], /-f source_run_id="\$GITHUB_RUN_ID"/)
  assert.doesNotMatch(graph["dispatch-examples"], /gh run watch|sleep /)
  assert.match(graph["dispatch-examples"], /dry_run != 'true'/)
  assert.notEqual(core.match(/^  group: (.+)$/m)[1], example.match(/^  group: (.+)$/m)[1])
  assert.match(example, /cancel-in-progress: false/)
  assert.match(jobs(example).plan, /if: github.event_name == 'workflow_dispatch'/)
})

test("docs can run with Play failed/skipped/in progress, but require both published download inputs", () => {
  const graph = jobs(workflow("coordinated-example-release.yml"))
  const ancestors = new Set()
  function walk(name) {
    for (const dependency of dependencies(graph[name])) {
      ancestors.add(dependency)
      walk(dependency)
    }
  }
  walk("docs")
  assert.deepEqual([...ancestors].sort(), ["example-testflight", "plan", "starter-kit"])
  const expression = graph.docs.match(/^    if: \$\{\{ (.+) \}\}$/m)[1]
  for (const play of ["failure", "skipped", "in_progress", "success"]) {
    for (const failedInput of [null, "plan", "starter-kit", "example-testflight"]) {
      const states = {
        "plan": "success",
        "starter-kit": "success",
        "example-testflight": "success",
        "example-google-play": play,
      }
      if (failedInput) states[failedInput] = "failure"
      const evaluate = (cancelled) =>
        Function(
          `return ${expression
            .replace(/cancelled\(\)/g, String(cancelled))
            .replace(/needs\.plan\.outputs\.dry_run/g, "'false'")
            .replace(/needs\.([a-z-]+)\.result/g, (_, key) => JSON.stringify(states[key]))}`,
        )()
      assert.equal(evaluate(false), !failedInput)
      assert.equal(evaluate(true), false)
    }
  }
})
