import assert from "node:assert/strict"
import test from "node:test"

import {
  advanceConfirmationMessage,
  branchPromotionState,
  deferralAttestation,
  exampleConfirmationMessage,
  packagesConfirmationMessage,
  parseCliArgs,
  parseJsonLines,
  promotionGateState,
  releaseBranchSources,
  requireCommandState,
  statusSummary,
  validateAdvanceOptions,
  validateExampleOptions,
  validatePackagesOptions,
  carriedDeferralReason,
  RECORD_COMMANDS,
  resubmitStep,
  selectDispatchedRun,
} from "./production-release.mjs"

const baseRecord = {
  schemaVersion: 1,
  kind: "mentra-production-promotion",
  promotionId: "mentra-3.1.0-attempt-1",
  releaseIdentity: "3.1.0",
  attempt: 1,
  state: "selected",
  sequence: 0,
  previous: null,
  createdAt: "2026-08-28T20:00:00.000Z",
  actor: "owner",
  provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
  selectedBeta: {
    identity: "3.1.0-beta.57",
    releaseSetId: "mentra-3.1.0-beta.57",
    manifestUrl: "https://example.com/beta.json",
    manifestSha256: "b".repeat(64),
  },
  source: {mentraosCommit: "a".repeat(40)},
  coordinates: {
    currentMentraApp: {
      provenance: "coordinated",
      sourceCommit: "f".repeat(40),
      provenanceUrl: "https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v3.0.0",
      ios: {marketingVersion: "3.0.0", buildNumber: 1},
      android: {marketingVersion: "3.0.0", buildNumber: 2},
    },
    compatibilityLab: {
      ios: {marketingVersion: "3.0.0", buildNumber: 3},
      android: {marketingVersion: "3.0.0", buildNumber: 3},
    },
    candidates: {
      mentraApp: {
        ios: {marketingVersion: "3.1.0", buildNumber: 3},
        android: {marketingVersion: "3.1.0", buildNumber: 4},
      },
    },
  },
  evidence: [],
}

test("parses value and boolean options without shell sourcing", () => {
  assert.deepEqual(parseCliArgs(["status", "--release", "3.1.0", "--attempt", "2", "--refresh", "--json"]), {
    command: "status",
    options: {release: "3.1.0", attempt: "2", refresh: true, json: true},
    positionals: [],
  })
})

test("reads exact branch sources from a completed coordinated beta", () => {
  assert.deepEqual(
    releaseBranchSources(
      {
        schemaVersion: 1,
        releaseIdentity: "3.1.0-beta.105",
        channel: "beta",
        completedAt: "2026-08-31T18:40:40.000Z",
        sourceCommit: "a".repeat(40),
      },
      "3.1.0-beta.105",
    ),
    {mentraosCommit: "a".repeat(40)},
  )
})

test("accepts ready and already-complete branch promotion retries", () => {
  assert.equal(branchPromotionState({behind_by: 5}, {behind_by: 0}), "ready")
  assert.equal(branchPromotionState({behind_by: 0}, {behind_by: 5}), "complete")
  assert.equal(branchPromotionState({behind_by: 0}, {behind_by: 0}), "complete")
  assert.equal(branchPromotionState({behind_by: 2}, {behind_by: 3}), "diverged")
})

test("rejects incomplete or mismatched beta branch sources", () => {
  const result = {
    schemaVersion: 1,
    releaseIdentity: "3.1.0-beta.105",
    channel: "beta",
    completedAt: "2026-08-31T18:40:40.000Z",
    sourceCommit: "a".repeat(40),
  }
  assert.throws(() => releaseBranchSources(result, "3.1.0-beta.106"), /does not describe completed beta/)
  assert.throws(() => releaseBranchSources({...result, completedAt: undefined}, result.releaseIdentity), /not complete/)
  assert.throws(
    () => releaseBranchSources({...result, sourceCommit: "short"}, result.releaseIdentity),
    /no valid MentraOS source commit/,
  )
})

test("reserves 100 percent for the completion command", () => {
  const rolling = {...baseRecord, state: "rolling-out"}
  assert.deepEqual(validateAdvanceOptions(rolling, {"android-percent": "99"}), {
    action: "advance",
    androidPercent: "99",
  })
  assert.deepEqual(validateAdvanceOptions(rolling, {complete: true}), {
    action: "complete",
    androidPercent: "100",
  })
  assert.match(
    advanceConfirmationMessage({action: "advance", androidPercent: "25"}),
    /increasing the Android production rollout to 25%/,
  )
  assert.match(advanceConfirmationMessage({action: "complete", androidPercent: "100"}), /completion/)
  assert.throws(() => validateAdvanceOptions(rolling, {"android-percent": "100"}), /use --complete/)
  assert.throws(
    () => validateAdvanceOptions({...rolling, state: "finalizing"}, {"android-percent": "99"}),
    /only be resumed with --complete/,
  )
})

test("treats the 100 percent finalizing checkpoint as a point of no return", () => {
  assert.throws(() => requireCommandState("abort", {...baseRecord, state: "finalizing"}), /Cannot abort/)
  assert.equal(validateAdvanceOptions({...baseRecord, state: "finalizing"}, {complete: true}).action, "complete")
})

const labReadyRecord = {
  ...baseRecord,
  evidence: [
    {
      kind: "staging-mobile-n-compatibility-lab",
      url: "https://github.com/Mentra-Community/MentraOS/actions/runs/2",
      sha256: "d".repeat(64),
      assetName: "production-compatibility-lab.json",
    },
  ],
}

test("describes the lab build and evidence gates as the next actions", () => {
  const summary = statusSummary(baseRecord)
  assert.equal(summary.state, "selected")
  assert.equal(summary.nextAction.workflow, "production-release-compatibility-lab.yml")
  assert.equal(statusSummary(labReadyRecord).nextAction.check, "staging-mobile-n-compatibility")
})

test("prevents commands from skipping promotion states", () => {
  assert.equal(requireCommandState("next", baseRecord).kind, "workflow")
  assert.throws(
    () => requireCommandState("attest", labReadyRecord, {check: "production-mobile-n-compatibility"}),
    /expects staging-mobile-n-compatibility/,
  )
  assert.throws(() => requireCommandState("release", baseRecord), /requires stores-approved/)
  assert.equal(requireCommandState("attest", labReadyRecord, {check: "staging-mobile-n-compatibility"}).kind, "attest")
  assert.equal(requireCommandState("advance", {...baseRecord, state: "finalizing"}).command, "advance")
})

test("defers only the pre-submission human gates and blocks release until they are attested", () => {
  const cloudDeployed = {...baseRecord, state: "cloud-deployed"}
  assert.equal(requireCommandState("defer", cloudDeployed, {check: "production-mobile-n-compatibility"}).kind, "attest")
  assert.throws(
    () => requireCommandState("defer", cloudDeployed, {check: "production-mobile-candidate-acceptance"}),
    /expects production-mobile-n-compatibility/,
  )
  assert.throws(
    () => requireCommandState("defer", {...baseRecord, state: "stores-submitted"}, {check: "store-review-approved"}),
    /can be deferred, not store-review-approved/,
  )
  const reference = (kind) => ({kind, url: "https://example.com/evidence.json", sha256: "c".repeat(64)})
  const deferred = {
    ...baseRecord,
    state: "stores-approved",
    evidence: [reference("production-mobile-n-compatibility-deferred")],
  }
  assert.equal(requireCommandState("attest", deferred, {check: "production-mobile-n-compatibility"}).kind, "command")
  assert.throws(() => requireCommandState("release", deferred), /deferred human gates to be attested first/)
  assert.deepEqual(statusSummary(deferred).deferredChecks, ["production-mobile-n-compatibility"])
  const resolved = {...deferred, evidence: [...deferred.evidence, reference("production-mobile-n-compatibility")]}
  assert.deepEqual(statusSummary(resolved).deferredChecks, [])
  assert.throws(
    () => requireCommandState("attest", resolved, {check: "production-mobile-n-compatibility"}),
    /expects command, not production-mobile-n-compatibility/,
  )
  const attestation = deferralAttestation({
    record: baseRecord,
    check: "production-mobile-n-compatibility",
    reason: "verify during store review",
    githubLogin: "owner",
    performedAt: "2026-09-12T01:00:00.000Z",
  })
  assert.equal(attestation.result, "deferred")
  assert.equal(attestation.promotionId, "mentra-3.1.0-attempt-1")
  assert.equal(attestation.tests, undefined)
})

test("dispatches stable package phases from the promoted beta without a promotion state", () => {
  assert.deepEqual(validatePackagesOptions({beta: "3.1.0-beta.192", phase: "publish"}), {
    beta_identity: "3.1.0-beta.192",
    phase: "publish",
  })
  assert.deepEqual(validatePackagesOptions({beta: "3.1.0-beta.192", phase: "release"}).phase, "release")
  assert.throws(() => validatePackagesOptions({beta: "3.1.0", phase: "publish"}), /--beta X\.Y\.Z-beta\.N/)
  assert.throws(
    () => validatePackagesOptions({beta: "3.1.0-beta.192", phase: "latest"}),
    /--phase publish or --phase release/,
  )
  assert.match(
    packagesConfirmationMessage({beta_identity: "3.1.0-beta.192", phase: "publish"}),
    /candidate npm dist-tag/,
  )
  assert.match(
    packagesConfirmationMessage({beta_identity: "3.1.0-beta.192", phase: "release"}),
    /moves npm latest.*3\.1\.0/,
  )
})

test("parses line-delimited gh projections and ignores blank lines", () => {
  assert.deepEqual(parseJsonLines('{"id":1,"tag_name":"a"}\n\n{"id":2,"tag_name":"b"}\n'), [
    {id: 1, tag_name: "a"},
    {id: 2, tag_name: "b"},
  ])
  assert.deepEqual(parseJsonLines(""), [])
  assert.throws(() => parseJsonLines("{not json}"), SyntaxError)
})

test("the promotion gate follows the ci-gate status and ignores push-triggered beta jobs", () => {
  const betaJob = {
    name: "Publish React Native example to Google Play / Build",
    workflow: "Coordinated Mentra Release",
    event: "push",
    bucket: "fail",
  }
  const bot = {name: "Plan agent cycle", workflow: "PR Agent Orchestrator", event: "pull_request", bucket: "fail"}
  const build = {
    name: "Mobile App iOS Build",
    workflow: "Mobile App iOS Build",
    event: "pull_request",
    bucket: "pending",
  }
  const gatePending = {
    name: "ci-gate-dev",
    workflow: "",
    event: "",
    bucket: "pending",
    description: "Waiting on: Mobile App iOS Build",
  }
  const gatePassed = {...gatePending, bucket: "pass", description: "All required area builds passed"}
  const gateFailed = {...gatePending, bucket: "fail"}

  assert.equal(promotionGateState([betaJob, bot, build, gatePending]).state, "pending")
  assert.equal(promotionGateState([betaJob, bot, build, gatePassed]).state, "passed")
  assert.deepEqual(promotionGateState([betaJob, bot, gateFailed]).rows, [gateFailed])
  // Without a ci-gate status only the pull request's gated area builders
  // decide; an advisory bot failing on the pull request never aborts.
  assert.equal(promotionGateState([betaJob, build]).state, "pending")
  assert.equal(promotionGateState([betaJob, {...build, bucket: "pass"}]).state, "passed")
  assert.equal(promotionGateState([betaJob, bot, {...build, bucket: "pass"}]).state, "passed")
  assert.equal(promotionGateState([betaJob, bot, {...build, bucket: "fail"}]).state, "failed")
  assert.equal(promotionGateState([betaJob, bot], {settled: true}).state, "passed")
  // Only the beta's push rows exist right after the PR is created: keep waiting
  // until registration has settled, then an empty gate means nothing applies.
  assert.equal(promotionGateState([betaJob]).state, "pending")
  assert.equal(promotionGateState([betaJob], {settled: false}).state, "pending")
  assert.equal(promotionGateState([betaJob], {settled: true}).state, "passed")
  assert.equal(promotionGateState([betaJob, build], {settled: true}).state, "pending")
  assert.equal(promotionGateState([betaJob, {...build, bucket: "fail"}], {settled: true}).state, "failed")
  assert.throws(() => promotionGateState(null), /must be an array/)
})

test("dispatches the production example from the promoted beta and never promises a store release", () => {
  assert.deepEqual(validateExampleOptions({beta: "3.1.0-beta.212"}), {beta_identity: "3.1.0-beta.212"})
  assert.throws(() => validateExampleOptions({beta: "3.1.0"}), /--beta X\.Y\.Z-beta\.N/)
  const message = exampleConfirmationMessage({beta_identity: "3.1.0-beta.212"})
  assert.match(message, /example 3\.1\.0 from the public 3\.1\.0 packages/)
  assert.match(message, /never releases the example to a store/)
})

test("resubmit decides every step from the latest and previous attempts and stops at the candidates", () => {
  const reference = (kind) => ({kind, url: "https://example.com/evidence.json", sha256: "c".repeat(64)})
  const beta = "3.1.0-beta.60"
  const rejected = {
    ...baseRecord,
    state: "stores-submitted",
    evidence: [reference("production-mobile-n-compatibility-deferred")],
  }
  // Only an attempt the stores rejected is abandoned; anything else must be aborted on purpose.
  assert.deepEqual(resubmitStep({record: rejected, betaIdentity: beta, mainHasBeta: true}), {kind: "abort", attempt: 1})
  assert.throws(
    () => resubmitStep({record: {...baseRecord, state: "cloud-deployed"}, betaIdentity: beta, mainHasBeta: true}),
    /not a store rejection; abort it explicitly/,
  )
  assert.throws(
    () => resubmitStep({record: {...baseRecord, state: "finalizing"}, betaIdentity: beta, mainHasBeta: true}),
    /100 percent rollout checkpoint/,
  )
  assert.throws(
    () => resubmitStep({record: {...baseRecord, state: "completed"}, betaIdentity: beta, mainHasBeta: true}),
    /nothing to resubmit/,
  )
  const aborted = {...rejected, state: "aborted"}
  assert.deepEqual(resubmitStep({record: aborted, betaIdentity: beta, mainHasBeta: false}), {kind: "promote"})
  assert.deepEqual(resubmitStep({record: aborted, betaIdentity: beta, mainHasBeta: true}), {kind: "start"})
  // A fresh invocation finds the replacement attempt by its beta and resumes it.
  const next = (state, evidence = []) => ({
    ...baseRecord,
    attempt: 2,
    promotionId: "mentra-3.1.0-attempt-2",
    state,
    evidence,
    selectedBeta: {...baseRecord.selectedBeta, identity: beta, releaseSetId: `mentra-${beta}`},
  })
  for (const [state, phase] of [
    ["staging-compatible", "preflight"],
    ["production-config-ready", "deploy"],
    ["current-clients-accepted", "build"],
  ]) {
    assert.equal(
      resubmitStep({record: next(state), previous: aborted, betaIdentity: beta, mainHasBeta: true}).phase,
      phase,
    )
  }
  assert.deepEqual(
    resubmitStep({record: next("cloud-deployed"), previous: aborted, betaIdentity: beta, mainHasBeta: true}),
    {
      kind: "defer",
      check: "production-mobile-n-compatibility",
    },
  )
  const attestedBefore = {...aborted, evidence: [reference("production-mobile-n-compatibility")]}
  assert.equal(
    resubmitStep({record: next("cloud-deployed"), previous: attestedBefore, betaIdentity: beta, mainHasBeta: true})
      .kind,
    "stop",
  )
  // From the uploaded candidates on, nothing is dispatched, even when the state machine would.
  for (const state of [
    "mobile-candidates-uploaded",
    "mobile-candidates-accepted",
    "stores-submitted",
    "public-release-approved",
  ]) {
    assert.equal(
      resubmitStep({record: next(state), previous: aborted, betaIdentity: beta, mainHasBeta: true}).kind,
      "stop",
    )
  }
  assert.equal(
    resubmitStep({record: next("selected"), previous: aborted, betaIdentity: beta, mainHasBeta: true}).kind,
    "stop",
  )
  // A replacement attempt started for another beta is never touched by accident.
  assert.throws(
    () =>
      resubmitStep({
        record: {...next("staging-compatible"), selectedBeta: baseRecord.selectedBeta},
        previous: aborted,
        betaIdentity: beta,
        mainHasBeta: true,
      }),
    /selected 3\.1\.0-beta\.57 and is at staging-compatible/,
  )
  assert.match(
    carriedDeferralReason(aborted, "production-mobile-n-compatibility", "fix"),
    /Carried from attempt 1 .* fix$/,
  )
})

test("resubmit adopts only the run whose name carries its dispatch id", () => {
  const run = (id, title) => ({
    databaseId: id,
    createdAt: "2026-09-15T20:00:10Z",
    url: `https://example.com/runs/${id}`,
    displayTitle: title,
  })
  const mine = "6f0d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
  const runs = [
    run(3, `3.1.1 attempt 2 preflight [${mine}]`),
    run(2, "3.1.1 attempt 2 preflight [other-id]"),
    run(1, "3.1.1 attempt 2 preflight "),
  ]
  assert.equal(selectDispatchedRun(runs, mine).databaseId, 3)
  assert.equal(selectDispatchedRun(runs.slice(1), mine), null)
  assert.throws(() => selectDispatchedRun([runs[0], {...runs[0], databaseId: 4}], mine), /more than one run/)
})

test("resubmit never depends on the common record load", () => {
  assert.equal(RECORD_COMMANDS.includes("resubmit"), false)
  assert.equal(RECORD_COMMANDS.includes("abort"), true)
})

test("the documented boolean flags parse without a value", () => {
  const {options} = parseCliArgs(["promote", "--beta", "3.1.0-beta.60", "--merge-admin", "--yes"])
  assert.deepEqual(options, {"beta": "3.1.0-beta.60", "merge-admin": true, "yes": true})
})
