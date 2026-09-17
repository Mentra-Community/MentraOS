import assert from "node:assert/strict"
import test from "node:test"

import {prepareProductionPromotion} from "./prepare-production-promotion.mjs"
import {createReleasePlan, familyBuildNumber, loadReleaseFamily, releaseRecordSha256} from "./release-family.mjs"

const family = loadReleaseFamily()
// Family-window numbers derived from the loaded family, so the fixtures follow
// the repository's family base version.
const n = (sequence) => familyBuildNumber(family.familyBaseVersion, sequence)

const betaPlan = createReleasePlan({
  family,
  channel: "beta",
  sequence: 57,
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: n(57),
})
const betaManifest = {
  schemaVersion: 1,
  releaseSetId: betaPlan.releaseSetId,
  releaseIdentity: betaPlan.releaseIdentity,
  familyBaseVersion: betaPlan.familyBaseVersion,
  channel: "beta",
  sourceCommit: betaPlan.sourceCommit,
  native: betaPlan.native,
  releasePlanSha256: releaseRecordSha256(betaPlan),
  completedAt: "2026-08-28T10:00:00.000Z",
  otaManifest: {url: "https://example.com/ota.json", sha256: "d".repeat(64)},
}
const previousManifest = {
  releaseIdentity: "3.0.0",
  sourceCommit: "f".repeat(40),
  native: {marketingVersion: "3.0.0", buildNumber: 300000100},
  url: "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-v3.0.0/manifest.json",
}

// The real inventory contract: App Store builds with their marketing version,
// Play tracks as {track: [versionCode, ...]}.
function inventory(bundleId, current, appleMax, googleMax, extra = {}) {
  const currentVersion = current?.marketingVersion ?? null
  const builds = [
    ...(current ? [{buildNumber: current.buildNumber, marketingVersion: currentVersion}] : []),
    {buildNumber: appleMax, marketingVersion: family.familyBaseVersion},
    ...(extra.appleBuilds || []),
  ]
  const internal = [googleMax, ...(extra.googleInternal || [])]
  return {
    apple: {
      bundleId,
      current,
      maxBuildNumber: Math.max(...builds.map((build) => build.buildNumber)),
      builds,
    },
    google: {
      packageName: bundleId,
      currentVersionCode: current?.buildNumber ?? null,
      maxVersionCode: Math.max(...internal),
      tracks: {internal, production: current ? [current.buildNumber] : []},
    },
  }
}

// Assets of a family build container: markers recorded by coordinated runs and
// ASG client pairs; only these decide the next production number.
const marker = (sequence, version = family.familyBaseVersion) => ({
  name: `mentra-build-number-${familyBuildNumber(version, sequence)}.json`,
})
const ownedMarker = (sequence, owner, version = family.familyBaseVersion) => ({
  schemaVersion: 1,
  kind: "mentra-family-build-number",
  familyBaseVersion: version,
  buildNumber: familyBuildNumber(version, sequence),
  sequence,
  owner,
})

function prepare(overrides = {}) {
  return prepareProductionPromotion({
    family,
    betaPlan,
    betaManifest,
    betaManifestUrl: "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.1.0/beta.json",
    betaManifestSha256: "b".repeat(64),
    previousManifest,
    mentraInventory: inventory("com.mentra.mentra", {marketingVersion: "3.0.0", buildNumber: 300000100}, n(60), n(59)),
    familyAssets: [marker(57)],
    currentFamilyAssets: [marker(100, "3.0.0")],
    attempt: 1,
    actor: "release-owner",
    createdAt: "2026-08-28T20:00:00.000Z",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
    ...overrides,
  })
}

test("freezes selected source and allocates the next family sequences", () => {
  const {productionPlan, record, markers} = prepare()
  assert.equal(productionPlan.channel, "production")
  // The lab rebuilds the current 3.0.0 app, so its number is that family's next sequence.
  assert.equal(record.coordinates.compatibilityLab.ios.buildNumber, familyBuildNumber("3.0.0", 101))
  assert.equal(record.coordinates.compatibilityLab.android.buildNumber, familyBuildNumber("3.0.0", 101))
  // The candidate is the family's next sequence after the beta (57).
  assert.equal(productionPlan.native.buildNumber, n(58))
  assert.equal(record.coordinates.candidates.mentraApp.ios.buildNumber, n(58))
  assert.deepEqual(
    markers.map(({containerBaseVersion, marker: m}) => [containerBaseVersion, m.buildNumber, m.sequence, m.owner]),
    [
      [family.familyBaseVersion, n(58), 58, `promotion:mentra-${family.familyBaseVersion}-attempt-1:candidate`],
      [
        "3.0.0",
        familyBuildNumber("3.0.0", 101),
        101,
        `promotion:mentra-${family.familyBaseVersion}-attempt-1:compatibility-lab`,
      ],
    ],
  )
  assert.deepEqual(Object.keys(record.coordinates.candidates), ["mentraApp"])
  assert.deepEqual(Object.keys(record.source), ["mentraosCommit"])
  assert.deepEqual(productionPlan.promotion.otaManifest, betaManifest.otaManifest)
  assert.equal(record.coordinates.currentMentraApp.sourceCommit, "f".repeat(40))
  assert.equal(record.coordinates.currentMentraApp.provenance, "coordinated")
  assert.equal(record.state, "selected")
})

test("first promotion freezes the store-observed public app and skips the compatibility lab", () => {
  const {productionPlan, record} = prepare({
    previousManifest: null,
    mentraInventory: inventory("com.mentra.mentra", {marketingVersion: "3.0", buildNumber: 51180073}, n(60), n(59)),
  })
  assert.equal(record.state, "staging-compatible")
  assert.deepEqual(record.coordinates.currentMentraApp, {
    provenance: "store-observed",
    sourceCommit: null,
    provenanceUrl: null,
    ios: {marketingVersion: "3.0", buildNumber: 51180073},
    android: {marketingVersion: "3.0", buildNumber: 51180073},
  })
  assert.equal(record.coordinates.compatibilityLab, null)
  assert.equal(productionPlan.native.buildNumber, n(58))
  assert.equal(record.coordinates.candidates.mentraApp.android.buildNumber, n(58))
})

test("allocates from the family container only, never from the stores", () => {
  const current = {marketingVersion: "3.0", buildNumber: 50572313}
  // Store inventories may hold anything (a stray 900000001, a next-family
  // upload): only the family's container decides the next sequence.
  const {productionPlan} = prepare({
    previousManifest: null,
    mentraInventory: inventory("com.mentra.mentra", current, 900000001, familyBuildNumber("9.9.9", 217)),
    familyAssets: [marker(57), marker(60), marker(61), marker(2, "9.9.9")],
  })
  assert.equal(productionPlan.native.buildNumber, n(62))

  // A retry of the same attempt finds the markers it already reserved and
  // freezes the same plan, even though the containers have moved on.
  const owner = `promotion:mentra-${family.familyBaseVersion}-attempt-1`
  const retried = prepare({
    familyAssets: [marker(57), marker(58), marker(59)],
    familyMarkers: [ownedMarker(58, `${owner}:candidate`), ownedMarker(59, "coordinated-run:9")],
    currentFamilyAssets: [marker(100, "3.0.0"), marker(101, "3.0.0"), marker(102, "3.0.0")],
    currentFamilyMarkers: [ownedMarker(101, `${owner}:compatibility-lab`, "3.0.0")],
  })
  assert.equal(retried.productionPlan.native.buildNumber, n(58))
  assert.equal(retried.record.coordinates.compatibilityLab.ios.buildNumber, familyBuildNumber("3.0.0", 101))
  // Another attempt's markers are not this attempt's reservations.
  const later = prepare({
    attempt: 2,
    familyAssets: [marker(57), marker(58)],
    familyMarkers: [ownedMarker(58, `${owner}:candidate`)],
    currentFamilyAssets: [marker(100, "3.0.0"), marker(101, "3.0.0")],
    currentFamilyMarkers: [ownedMarker(101, `${owner}:compatibility-lab`, "3.0.0")],
  })
  assert.equal(later.productionPlan.native.buildNumber, n(59))
  assert.equal(later.record.coordinates.compatibilityLab.ios.buildNumber, familyBuildNumber("3.0.0", 102))

  // A container that does not record the selected beta is refused: the beta
  // was not cut by the coordinated pipeline that records numbers.
  assert.throws(
    () => prepare({previousManifest: null, familyAssets: [marker(3)]}),
    /does not record the selected beta build/,
  )
  const strayBeta = {...betaPlan, native: {...betaPlan.native, buildNumber: 900000002}}
  assert.throws(
    () =>
      prepare({
        betaPlan: strayBeta,
        betaManifest: {...betaManifest, native: strayBeta.native, releasePlanSha256: releaseRecordSha256(strayBeta)},
      }),
    /outside the .* family window/,
  )
  assert.throws(
    () => prepare({previousManifest: null, familyAssets: [marker(2999)]}),
    /exhausted its release build numbers/,
  )
  assert.throws(
    () =>
      prepare({
        previousManifest: null,
        mentraInventory: {
          ...inventory("com.mentra.mentra", current, n(60), n(59)),
          google: {...inventory("com.mentra.mentra", null, n(60), n(59)).google, currentVersionCode: n(70)},
        },
      }),
    /not above the Google Play production version code/,
  )
  // The lab needs the current family's container.
  assert.throws(() => prepare({currentFamilyAssets: null}), /build container of the current family 3\.0\.0 is required/)
  assert.throws(() => prepare({currentFamilyAssets: []}), /does not record the current public build/)
})

test("a coordinated current app that predates the formula is frozen store-observed and needs a family above Play's code", () => {
  // A 3.0.0 release shipped with a timestamp number: no 3.0.0-window number
  // installs over it, so there is no compatibility lab; Phase 5 still verifies
  // the store app. The 3.1.x candidate is above Play's 50572796.
  const legacyManifest = {...previousManifest, native: {marketingVersion: "3.0.0", buildNumber: 50572796}}
  const {productionPlan, record} = prepare({
    previousManifest: legacyManifest,
    mentraInventory: inventory("com.mentra.mentra", {marketingVersion: "3.0.0", buildNumber: 50572796}, n(60), n(59)),
    currentFamilyAssets: null,
  })
  assert.equal(record.coordinates.currentMentraApp.provenance, "store-observed")
  assert.equal(record.coordinates.currentMentraApp.sourceCommit, null)
  assert.equal(record.coordinates.compatibilityLab, null)
  assert.equal(record.state, "staging-compatible")
  assert.equal(productionPlan.native.buildNumber, n(58))

  // A flat 310000213 in production sits above the whole 3.1.x window: the
  // candidate cannot exceed it and the error says what would.
  const flatManifest = {...previousManifest, native: {marketingVersion: "3.0.0", buildNumber: 310000213}}
  assert.throws(
    () =>
      prepare({
        previousManifest: flatManifest,
        mentraInventory: inventory(
          "com.mentra.mentra",
          {marketingVersion: "3.0.0", buildNumber: 310000213},
          n(60),
          n(59),
        ),
        currentFamilyAssets: null,
      }),
    /not above the Google Play production version code 310000213; release under a family base version whose window lies above that code/,
  )
})

test("first promotion still requires a public app in both stores", () => {
  assert.throws(
    () =>
      prepare({
        previousManifest: null,
        mentraInventory: inventory("com.mentra.mentra", null, n(60), n(59)),
      }),
    /has no current public store release/,
  )
})

test("rejects store state that does not match current production provenance", () => {
  assert.throws(
    () =>
      prepare({
        mentraInventory: inventory(
          "com.mentra.mentra",
          {marketingVersion: "3.0.0", buildNumber: 300000099},
          n(60),
          n(59),
        ),
      }),
    /do not match the previous production manifest/,
  )
})

test("rejects an incomplete selected beta", () => {
  assert.throws(() => prepare({betaManifest: {...betaManifest, completedAt: undefined}}), /not complete/)
})
