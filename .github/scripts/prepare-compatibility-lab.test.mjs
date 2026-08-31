import assert from "node:assert/strict"
import test from "node:test"

import {loadReleaseFamily} from "./release-family.mjs"
import {prepareCompatibilityLabPlan} from "./prepare-compatibility-lab.mjs"

const commit = (value) => value.repeat(40)
const digest = (value) => value.repeat(64)
const family = loadReleaseFamily({rootDir: process.cwd(), requireVersionMirrors: true})
const currentVersion = family.familyBaseVersion
const currentSource = commit("a")
const record = {
  schemaVersion: 1,
  kind: "mentra-production-promotion",
  promotionId: "mentra-99.0.0-attempt-1",
  releaseIdentity: "99.0.0",
  attempt: 1,
  state: "selected",
  sequence: 0,
  previous: null,
  createdAt: "2026-08-28T20:00:00.000Z",
  actor: "owner",
  provenanceUrl: "https://example.com/actions/1",
  selectedBeta: {
    identity: "99.0.0-beta.1",
    releaseSetId: "mentra-99.0.0-beta.1",
    manifestUrl: "https://example.com/beta.json",
    manifestSha256: digest("b"),
  },
  source: {mentraosCommit: commit("c")},
  coordinates: {
    currentMentraApp: {
      sourceCommit: currentSource,
      provenanceUrl: "https://example.com/current.json",
      ios: {marketingVersion: currentVersion, buildNumber: 100},
      android: {marketingVersion: currentVersion, buildNumber: 100},
    },
    compatibilityLab: {
      ios: {marketingVersion: currentVersion, buildNumber: 101},
      android: {marketingVersion: currentVersion, buildNumber: 101},
    },
    candidates: {
      mentraApp: {
        ios: {marketingVersion: "99.0.0", buildNumber: 102},
        android: {marketingVersion: "99.0.0", buildNumber: 102},
      },
    },
  },
  evidence: [],
}
const previousPlan = {
  channel: "production",
  sourceCommit: currentSource,
  native: {marketingVersion: currentVersion, buildNumber: 100},
  otaInputs: {asg: {source: "current-production"}},
}

test("creates a beta-shaped, staging-targeted, non-promotable Mobile N plan", () => {
  const plan = prepareCompatibilityLabPlan({root: process.cwd(), record, previousPlan})
  assert.equal(plan.sourceCommit, currentSource)
  assert.equal(plan.native.marketingVersion, currentVersion)
  assert.equal(plan.native.buildNumber, 101)
  assert.equal(plan.compatibilityLab.nonPromotable, true)
  assert.match(plan.compatibilityLab.runtimeLabel, /COMPATIBILITY-LAB-NOT-FOR-PRODUCTION$/)
})

test("rejects a prior plan from a different public source", () => {
  assert.throws(
    () =>
      prepareCompatibilityLabPlan({
        root: process.cwd(),
        record,
        previousPlan: {...previousPlan, sourceCommit: commit("e")},
      }),
    /does not match the public Mentra App provenance/,
  )
})
