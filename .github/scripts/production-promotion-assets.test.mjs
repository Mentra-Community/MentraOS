import assert from "node:assert/strict"
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  matchingPromotionContainers,
  nextPromotionAttempt,
  planPromotionContainerAllocation,
  prepareEvidenceAsset,
  productionPromotionSelectionDigest,
  promotionContainerBody,
  promotionContainerName,
  promotionContainerTag,
  requireNewPromotionAttemptAllowed,
  requirePromotionContainer,
  stateAssets,
  validateStateRecordChain,
} from "./production-promotion-assets.mjs"
import {
  abortPromotionRecord,
  createInitialPromotionRecord,
  promotionAssetName,
  transitionPromotionRecord,
} from "./production-promotion-state.mjs"

test("stages workflow evidence under an immutable content-addressed name", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "promotion-evidence-"))
  const source = path.join(directory, "result.json")
  writeFileSync(source, '{"result":"pass"}\n')
  const result = prepareEvidenceAsset({
    file: source,
    kind: "production-mobile-candidates",
    url: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
    outputDirectory: directory,
  })
  assert.match(result.assetName, /^production-evidence-production-mobile-candidates-[0-9a-f]{64}\.json$/)
  assert.deepEqual(readFileSync(result.assetPath), readFileSync(source))
  assert.equal(result.reference.assetName, result.assetName)
  assert.equal(result.reference.url, "https://github.com/Mentra-Community/MentraOS/actions/runs/123")
  writeFileSync(source, '{"result":"retry"}\n')
  assert.notEqual(
    prepareEvidenceAsset({
      file: source,
      kind: "production-mobile-candidates",
      url: "https://github.com/Mentra-Community/MentraOS/actions/runs/124",
      outputDirectory: directory,
    }).assetName,
    result.assetName,
  )
})

function release(attempt, overrides = {}) {
  return {
    id: attempt,
    tag_name: promotionContainerTag("3.1.0", attempt),
    name: promotionContainerName("3.1.0", attempt),
    draft: true,
    prerelease: false,
    ...overrides,
  }
}

test("allocates monotonic promotion attempts and validates the draft container", () => {
  const releases = [release(2), release(1), {tag_name: "unrelated"}]
  assert.deepEqual(
    matchingPromotionContainers(releases, "3.1.0").map((item) => item.attempt),
    [1, 2],
  )
  assert.equal(nextPromotionAttempt(releases, "3.1.0"), 3)
  assert.equal(requirePromotionContainer(releases, "3.1.0", 2).id, 2)
  assert.throws(() => requirePromotionContainer([release(1, {draft: false})], "3.1.0", 1), /unexpected/)
})

test("sorts state assets and rejects duplicate sequence numbers", () => {
  const assets = [
    {id: 2, name: "production-promotion-3.1.0-attempt-1-01-staging-compatible.json"},
    {id: 1, name: "production-promotion-3.1.0-attempt-1-00-selected.json"},
    {id: 99, name: "human-evidence.json"},
  ]
  assert.deepEqual(
    stateAssets(assets, "3.1.0", 1).map((item) => [item.sequence, item.state]),
    [
      [0, "selected"],
      [1, "staging-compatible"],
    ],
  )
  assert.throws(
    () =>
      stateAssets(
        [...assets, {id: 3, name: "production-promotion-3.1.0-attempt-1-01-cloud-deployed.json"}],
        "3.1.0",
        1,
      ),
    /duplicate/,
  )
})

function recordEvidence(kind) {
  return {
    kind,
    url: `https://example.com/${kind}.json`,
    sha256: "d".repeat(64),
    assetName: `${kind}.json`,
  }
}

function initialRecord() {
  const coordinate = (buildNumber) => ({marketingVersion: "3.1.0", buildNumber})
  return createInitialPromotionRecord({
    releaseIdentity: "3.1.0",
    attempt: 1,
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
        provenanceUrl: "https://example.com/current.json",
        ios: coordinate(1),
        android: coordinate(1),
      },
      compatibilityLab: {ios: coordinate(2), android: coordinate(2)},
      candidates: {
        mentraApp: {ios: coordinate(3), android: coordinate(3)},
        starterKit: {ios: coordinate(4), android: coordinate(4)},
      },
    },
    actor: "owner",
    createdAt: "2026-08-28T20:00:00.000Z",
    provenanceUrl: "https://example.com/actions/1",
  })
}

test("allows a replacement only after every prior attempt is aborted", () => {
  const active = initialRecord()
  assert.throws(() => requireNewPromotionAttemptAllowed([active], "3.1.0"), /attempt 1 is selected/)
  const aborted = abortPromotionRecord({
    record: active,
    actor: "owner",
    createdAt: "2026-08-28T20:02:00.000Z",
    provenanceUrl: "https://example.com/actions/3",
    reason: "candidate rejected before public release",
  })
  assert.doesNotThrow(() => requireNewPromotionAttemptAllowed([aborted], "3.1.0"))
  assert.throws(() => requireNewPromotionAttemptAllowed([aborted], "3.2.0"), /belongs to 3.1.0/)
})

test("resumes the latest empty container only for the complete frozen selection", () => {
  const targetCommit = "a".repeat(40)
  const selectedBeta = "3.1.0-beta.57"
  const selectionDigest = productionPromotionSelectionDigest({beta: selectedBeta, storeMax: 57})
  const draft = release(2, {
    body: promotionContainerBody("3.1.0", selectedBeta, selectionDigest),
    target_commitish: targetCommit,
  })
  const aborted = abortPromotionRecord({
    record: initialRecord(),
    actor: "owner",
    createdAt: "2026-08-28T20:02:00.000Z",
    provenanceUrl: "https://example.com/actions/3",
    reason: "candidate rejected before public release",
  })
  const containers = [
    {releaseIdentity: "3.1.0", attempt: 1, release: release(1), record: aborted},
    {releaseIdentity: "3.1.0", attempt: 2, release: draft, record: null},
  ]
  const allocation = planPromotionContainerAllocation(containers, {
    releaseIdentity: "3.1.0",
    targetCommit,
    selectedBeta,
    selectionDigest,
  })
  assert.equal(allocation.action, "reuse")
  assert.equal(allocation.attempt, 2)
  assert.equal(allocation.release, draft)
  assert.throws(
    () =>
      planPromotionContainerAllocation(containers, {
        releaseIdentity: "3.1.0",
        targetCommit: "b".repeat(40),
        selectedBeta,
        selectionDigest,
      }),
    /another frozen selection/,
  )
  assert.throws(
    () =>
      planPromotionContainerAllocation(containers, {
        releaseIdentity: "3.1.0",
        targetCommit,
        selectedBeta: "3.1.0-beta.58",
        selectionDigest,
      }),
    /another frozen selection/,
  )
  assert.throws(
    () =>
      planPromotionContainerAllocation(containers, {
        releaseIdentity: "3.1.0",
        targetCommit,
        selectedBeta,
        selectionDigest: productionPromotionSelectionDigest({beta: selectedBeta, storeMax: 58}),
      }),
    /another frozen selection/,
  )
  assert.throws(
    () =>
      planPromotionContainerAllocation([...containers, {...containers[1], attempt: 3, release: release(3)}], {
        releaseIdentity: "3.1.0",
        targetCommit,
        selectedBeta,
        selectionDigest,
      }),
    /Multiple empty/,
  )
})

test("selection digests are canonical and cover every frozen input", () => {
  const selection = {
    betaPlan: {sourceCommit: "a".repeat(40), native: {buildNumber: 57}},
    previousManifestSha256: "b".repeat(64),
    starterKitCommit: "c".repeat(40),
    mentraInventory: {apple: {maxBuildNumber: 57}},
  }
  assert.equal(
    productionPromotionSelectionDigest(selection),
    productionPromotionSelectionDigest({
      mentraInventory: selection.mentraInventory,
      starterKitCommit: selection.starterKitCommit,
      previousManifestSha256: selection.previousManifestSha256,
      betaPlan: selection.betaPlan,
    }),
  )
  assert.notEqual(
    productionPromotionSelectionDigest(selection),
    productionPromotionSelectionDigest({...selection, starterKitCommit: "d".repeat(40)}),
  )
  assert.notEqual(
    productionPromotionSelectionDigest(selection),
    productionPromotionSelectionDigest({...selection, mentraInventory: {apple: {maxBuildNumber: 58}}}),
  )
})

test("validates every immutable state and digest before returning latest", () => {
  const initial = initialRecord()
  const lab = transitionPromotionRecord({
    record: initial,
    to: "selected",
    actor: "owner",
    createdAt: "2026-08-28T20:01:00.000Z",
    provenanceUrl: "https://example.com/actions/2",
    evidence: recordEvidence("staging-mobile-n-compatibility-lab"),
  })
  const entries = [initial, lab].map((record) => ({
    sequence: record.sequence,
    state: record.state,
    asset: {name: promotionAssetName(record)},
    record,
  }))
  assert.equal(validateStateRecordChain(entries, "3.1.0", 1), lab)
  const tampered = structuredClone(entries)
  tampered[1].record.coordinates.candidates.mentraApp.ios.buildNumber += 1
  assert.throws(() => validateStateRecordChain(tampered, "3.1.0", 1), /digest|frozen field coordinates/)
})
