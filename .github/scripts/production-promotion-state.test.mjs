import assert from "node:assert/strict"
import test from "node:test"

import {releaseRecordSha256} from "./release-family.mjs"
import {
  ATTESTATION_CHECKS,
  PROMOTION_STATES,
  abortPromotionRecord,
  createInitialPromotionRecord,
  nextAction,
  promotionAssetName,
  transitionPromotionRecord,
  transitionWithAttestation,
  validateAttestation,
  validatePromotionChain,
  validatePromotionRecord,
} from "./production-promotion-state.mjs"

const now = "2026-08-28T20:00:00.000Z"
const runUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"

function coordinate(buildNumber) {
  return {marketingVersion: "3.1.0", buildNumber}
}

function initial() {
  return createInitialPromotionRecord({
    releaseIdentity: "3.1.0",
    attempt: 1,
    selectedBeta: {
      identity: "3.1.0-beta.57",
      releaseSetId: "mentra-3.1.0-beta.57",
      manifestUrl: "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0/beta.json",
      manifestSha256: "b".repeat(64),
    },
    source: {mentraosCommit: "a".repeat(40)},
    coordinates: {
      currentMentraApp: {
        sourceCommit: "f".repeat(40),
        provenanceUrl: "https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v3.0.0",
        ios: coordinate(300000100),
        android: coordinate(300000101),
      },
      compatibilityLab: {ios: coordinate(310000090), android: coordinate(310000090)},
      candidates: {
        mentraApp: {ios: coordinate(310000100), android: coordinate(310000101)},
      },
    },
    actor: "release-owner",
    createdAt: now,
    provenanceUrl: runUrl,
  })
}

function evidence(kind = "test") {
  return {
    kind,
    url: `https://github.com/Mentra-Community/MentraOS/releases/download/evidence/${kind}.json`,
    sha256: "d".repeat(64),
    assetName: `${kind}.json`,
  }
}

function withCompatibilityLab(record = initial()) {
  return transitionPromotionRecord({
    record,
    to: "selected",
    actor: "release-owner",
    createdAt: now,
    provenanceUrl: runUrl,
    evidence: evidence("staging-mobile-n-compatibility-lab"),
  })
}

function atState(target) {
  let record = withCompatibilityLab()
  const targetIndex = PROMOTION_STATES.indexOf(target)
  for (const state of PROMOTION_STATES.slice(1, targetIndex + 1)) {
    record = transitionPromotionRecord({
      record,
      to: state,
      actor: "release-owner",
      createdAt: now,
      provenanceUrl: runUrl,
      evidence: evidence(state === "staging-compatible" ? "staging-mobile-n-compatibility" : state),
    })
  }
  return record
}

test("creates a deterministic initial promotion and append-only transition", () => {
  const selected = initial()
  assert.equal(selected.state, "selected")
  assert.equal(selected.sequence, 0)
  assert.equal(promotionAssetName(selected), "production-promotion-3.1.0-attempt-1-00-selected.json")
  const labReady = withCompatibilityLab(selected)
  assert.equal(nextAction(labReady).check, "staging-mobile-n-compatibility")
  const compatible = transitionPromotionRecord({
    record: labReady,
    to: "staging-compatible",
    actor: "qa-owner",
    createdAt: "2026-08-28T20:30:00.000Z",
    provenanceUrl: runUrl,
    evidence: evidence("staging-mobile-n-compatibility"),
  })
  assert.equal(compatible.previous.sha256, releaseRecordSha256(labReady))
  assert.equal(compatible.previous.assetName, promotionAssetName(labReady))
  assert.equal(nextAction(compatible).phase, "preflight")
  assert.equal(validatePromotionChain(labReady, compatible), compatible)
})

test("records protected Cloud deployment as one resumable transition", () => {
  const labReady = withCompatibilityLab()
  const compatible = transitionPromotionRecord({
    record: labReady,
    to: "staging-compatible",
    actor: "qa-owner",
    createdAt: now,
    provenanceUrl: runUrl,
    evidence: evidence("staging-mobile-n-compatibility"),
  })
  const configReady = transitionPromotionRecord({
    record: compatible,
    to: "production-config-ready",
    actor: "release-owner",
    createdAt: now,
    provenanceUrl: runUrl,
    evidence: evidence("production-cloud-config-preflight"),
  })
  assert.equal(nextAction(configReady).phase, "deploy")
  const deployed = transitionPromotionRecord({
    record: configReady,
    to: "cloud-deployed",
    actor: "release-owner",
    createdAt: now,
    provenanceUrl: runUrl,
    evidence: evidence("production-cloud-v2-deployment"),
  })
  assert.equal(deployed.sequence, configReady.sequence + 1)
  assert.equal(nextAction(deployed).check, "production-mobile-n-compatibility")
})

test("rejects skipped states, changed identities, and malformed chain digests", () => {
  const selected = initial()
  assert.throws(
    () =>
      transitionPromotionRecord({
        record: selected,
        to: "staging-compatible",
        actor: "operator",
        createdAt: now,
        provenanceUrl: runUrl,
        evidence: evidence("staging-mobile-n-compatibility"),
      }),
    /requires lab build evidence/,
  )
  assert.throws(
    () =>
      transitionPromotionRecord({
        record: selected,
        to: "cloud-deployed",
        actor: "operator",
        createdAt: now,
        provenanceUrl: runUrl,
        evidence: evidence(),
      }),
    /not contiguous/,
  )
  assert.throws(() => validatePromotionRecord({...selected, promotionId: "other"}), /promotionId/)
  const labReady = withCompatibilityLab(selected)
  const compatible = transitionPromotionRecord({
    record: labReady,
    to: "staging-compatible",
    actor: "operator",
    createdAt: now,
    provenanceUrl: runUrl,
    evidence: evidence("staging-mobile-n-compatibility"),
  })
  assert.throws(
    () => validatePromotionChain(labReady, {...compatible, previous: {...compatible.previous, sha256: "e".repeat(64)}}),
    /digest/,
  )
  assert.throws(
    () =>
      validatePromotionChain(labReady, {...compatible, source: {...compatible.source, mentraosCommit: "e".repeat(40)}}),
    /frozen field source/,
  )
})

test("requires complete platform coverage and rejects credential-like evidence", () => {
  const record = withCompatibilityLab()
  const attestation = {
    schemaVersion: 1,
    promotionId: record.promotionId,
    releaseIdentity: record.releaseIdentity,
    check: "staging-mobile-n-compatibility",
    result: "pass",
    performedAt: now,
    tester: {githubLogin: "qa-owner"},
    tests: [
      {
        product: "mentra-app",
        platform: "ios",
        result: "pass",
        appVersion: "3.1.0",
        appBuild: 310000090,
        deviceModel: "iPhone 15",
        osVersion: "iOS 19",
      },
    ],
    evidenceUrls: [runUrl],
  }
  assert.throws(() => validateAttestation(attestation, record), /mentra-app:android/)
  attestation.tests.push({
    product: "mentra-app",
    platform: "android",
    result: "pass",
    appVersion: "3.1.0",
    appBuild: 310000090,
    deviceModel: "Pixel 9",
    osVersion: "Android 16",
  })
  assert.equal(validateAttestation(attestation, record), attestation)
  assert.throws(
    () =>
      validateAttestation(
        {...attestation, tests: [...attestation.tests, {...attestation.tests[0], product: "starter-kit"}]},
        record,
      ),
    /product is unsupported/,
  )
  assert.throws(
    () =>
      validateAttestation(
        {...attestation, tests: [{...attestation.tests[0], appBuild: "BUILD"}, attestation.tests[1]]},
        record,
      ),
    /does not match frozen mentra-app:ios coordinate/,
  )
  assert.throws(
    () => validateAttestation({...attestation, tests: [...attestation.tests, attestation.tests[0]]}, record),
    /duplicate coverage/,
  )
  const advanced = transitionWithAttestation({
    record,
    attestation,
    actor: "qa-owner",
    createdAt: now,
    provenanceUrl: runUrl,
    evidenceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123/artifacts/1",
    assetName: "attestation.json",
    sha256: "9".repeat(64),
  })
  assert.equal(advanced.state, "staging-compatible")
  assert.throws(
    () => validateAttestation({...attestation, notes: `Bearer ${"x".repeat(40)}`}, record),
    /credential material/,
  )
})

test("binds every human gate to its check-specific frozen coordinates", () => {
  const initialRecord = initial()
  const cases = [
    {
      check: "production-mobile-n-compatibility",
      record: atState("cloud-deployed"),
      coordinates: {"mentra-app": initialRecord.coordinates.currentMentraApp},
    },
    {
      check: "production-mobile-candidate-acceptance",
      record: atState("mobile-candidates-uploaded"),
      coordinates: {"mentra-app": initialRecord.coordinates.candidates.mentraApp},
    },
    {
      check: "store-review-approved",
      record: atState("stores-submitted"),
      coordinates: {"mentra-app": initialRecord.coordinates.candidates.mentraApp},
    },
  ]
  for (const {check, record, coordinates} of cases) {
    const tests = ATTESTATION_CHECKS[check].coverage.map((coverage) => {
      const [product, platform] = coverage.split(":")
      const coordinate = coordinates[product][platform]
      return {
        product,
        platform,
        result: "pass",
        appVersion: coordinate.marketingVersion,
        appBuild: coordinate.buildNumber,
        deviceModel: "release device",
        osVersion: "release OS",
      }
    })
    const attestation = {
      schemaVersion: 1,
      promotionId: record.promotionId,
      releaseIdentity: record.releaseIdentity,
      check,
      result: "pass",
      performedAt: now,
      tester: {githubLogin: "qa-owner"},
      tests,
      evidenceUrls: [runUrl],
    }
    assert.equal(validateAttestation(attestation, record), attestation)
    const wrong = structuredClone(attestation)
    wrong.tests[0].appBuild += 1
    assert.throws(() => validateAttestation(wrong, record), /does not match frozen/)
  }
})

test("rejects Starter Kit fields from the Mentra-App-only production schema", () => {
  const record = initial()
  assert.throws(
    () => validatePromotionRecord({...record, source: {...record.source, starterKitCommit: "c".repeat(40)}}),
    /source must contain only mentraosCommit/,
  )
  assert.throws(
    () =>
      validatePromotionRecord({
        ...record,
        coordinates: {
          ...record.coordinates,
          candidates: {
            ...record.coordinates.candidates,
            starterKit: {ios: coordinate(310000200), android: coordinate(310000201)},
          },
        },
      }),
    /coordinates.candidates must contain only mentraApp/,
  )
})

test("aborting is terminal and preserves the previous digest", () => {
  const selected = initial()
  const aborted = abortPromotionRecord({
    record: selected,
    actor: "release-owner",
    createdAt: now,
    provenanceUrl: runUrl,
    reason: "Selected beta was withdrawn",
  })
  assert.equal(aborted.state, "aborted")
  assert.equal(aborted.previous.sha256, releaseRecordSha256(selected))
  assert.equal(nextAction(aborted).kind, "none")
  assert.throws(
    () =>
      transitionPromotionRecord({
        record: aborted,
        to: "staging-compatible",
        actor: "operator",
        createdAt: now,
        provenanceUrl: runUrl,
        evidence: evidence(),
      }),
    /cannot append after terminal state/,
  )
})

test("allows append-only rollout observations before completion", () => {
  let record = withCompatibilityLab()
  for (const state of PROMOTION_STATES.slice(1, PROMOTION_STATES.indexOf("rolling-out") + 1)) {
    record = transitionPromotionRecord({
      record,
      to: state,
      actor: "release-owner",
      createdAt: "2026-08-28T13:00:00.000Z",
      provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/2",
      evidence: evidence(state === "staging-compatible" ? "staging-mobile-n-compatibility" : state),
    })
  }
  const observed = transitionPromotionRecord({
    record,
    to: "rolling-out",
    actor: "release-owner",
    createdAt: "2026-08-28T14:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/3",
    evidence: evidence("rollout-observation"),
  })
  assert.equal(observed.state, "rolling-out")
  assert.equal(observed.sequence, record.sequence + 1)

  const finalizing = transitionPromotionRecord({
    record: observed,
    to: "finalizing",
    actor: "release-owner",
    createdAt: "2026-08-28T15:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/4",
    evidence: evidence("production-rollout-observation"),
  })
  assert.throws(
    () =>
      abortPromotionRecord({
        record: finalizing,
        actor: "release-owner",
        createdAt: "2026-08-28T15:30:00.000Z",
        provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/4",
        reason: "too late to replace a fully public rollout",
      }),
    /cannot abort after the 100 percent rollout checkpoint/,
  )
  const completed = transitionPromotionRecord({
    record: finalizing,
    to: "completed",
    actor: "release-owner",
    createdAt: "2026-08-28T16:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/5",
    evidence: evidence("production-release-manifest"),
  })
  assert.equal(completed.state, "completed")
  assert.equal(completed.previous.assetName, promotionAssetName(finalizing))
})
