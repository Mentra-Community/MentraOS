import assert from "node:assert/strict"
import test from "node:test"

import {parseCliArgs, requireCommandState, statusSummary} from "./production-release.mjs"

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
  source: {mentraosCommit: "a".repeat(40), starterKitCommit: "c".repeat(40)},
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
      starterKit: {
        ios: {marketingVersion: "3.1.0", buildNumber: 5},
        android: {marketingVersion: "3.1.0", buildNumber: 6},
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
