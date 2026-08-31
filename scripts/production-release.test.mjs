import assert from "node:assert/strict"
import test from "node:test"

import {
  advanceConfirmationMessage,
  parseCliArgs,
  requireCommandState,
  statusSummary,
  validateAdvanceOptions,
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
