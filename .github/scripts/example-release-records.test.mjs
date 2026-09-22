import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  EXAMPLE_RELEASE_KIND,
  assembleExampleReleaseResults,
  exampleReleaseAssetName,
  reconcileExampleReleaseRecord,
  validateExampleReleaseRecord,
  verifyStarterKitResult,
} from "./example-release-records.mjs"
import {createReleasePlan, familyBuildNumber, loadReleaseFamily} from "./release-family.mjs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const family = loadReleaseFamily({rootDir})
const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"

function planFor(channel = "beta") {
  return createReleasePlan({
    family,
    channel,
    sequence: 57,
    sourceCommit: "a".repeat(40),
    nativeBuildNumber: familyBuildNumber(family.familyBaseVersion, 57),
  })
}

function fixtures(plan) {
  const betaManifest = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    sourceCommit: plan.sourceCommit,
    completedAt: "2026-08-25T01:00:00.000Z",
  }
  const starterKit = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    familyBaseVersion: plan.familyBaseVersion,
    channel: plan.channel,
    mentraos: {sourceCommit: plan.sourceCommit, coordinatorRunUrl: provenanceUrl},
    ota: {manifestUrl: "https://example.com/ota.json", manifestSha256: "c".repeat(64)},
    starterKit: {
      baseCommit: "1".repeat(40),
      releaseCommit: "2".repeat(40),
      mergeCommit: "3".repeat(40),
      sourceTag: `sdk-${plan.releaseIdentity}`,
      artifactContainerTag: `sdk-builds-v${plan.familyBaseVersion}`,
      releaseUrl: `https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit/releases/tag/sdk-builds-v${family.familyBaseVersion}`,
      pullRequestUrl: "https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit/pull/51",
      validationRunUrl: "https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit/actions/runs/456",
    },
    packages: {
      "@mentra/bluetooth-sdk": plan.releaseIdentity,
      "@mentra/engine": plan.releaseIdentity,
    },
    artifacts: ["ios", "reactNative", "reactNativeElevenLabsAudio"].map((key, index) => ({
      key,
      name: `mentra-example-${key}-${plan.releaseIdentity}.${key === "ios" ? "ipa" : "apk"}`,
      url: `https://example.com/mentra-example-${key}-${plan.releaseIdentity}`,
      size: index + 1,
      sha256: String(index + 1).repeat(64),
      contentType: "application/octet-stream",
    })),
  }
  const exampleTestflight = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    mentraosSourceCommit: plan.sourceCommit,
    starterKitReleaseCommit: starterKit.starterKit.releaseCommit,
    app: {id: "6792839366", bundleId: "com.mentra.bluetoothsdkexample"},
    version: {marketingVersion: plan.native.marketingVersion, buildNumber: plan.native.buildNumber},
    build: {id: "build-1", processingState: "VALID", uploadStatus: "published"},
    group: {id: "group-1", name: "Mentra Staging Public"},
    distribution: {
      audience: "external",
      status: "submitted",
      installUrl: "https://testflight.apple.com/join/public123",
      reviewState: "WAITING_FOR_REVIEW",
    },
    provenanceUrl,
    ipa: {size: 123, sha256: "9".repeat(64)},
  }
  const exampleGooglePlay = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    mentraosSourceCommit: plan.sourceCommit,
    starterKitReleaseCommit: starterKit.starterKit.releaseCommit,
    packageId: "com.mentra.bluetoothsdkexample",
    version: {marketingVersion: plan.native.marketingVersion, buildNumber: plan.native.buildNumber},
    track: "beta",
    uploadStatus: "published",
    distribution: {
      status: "submitted",
      audience: "external",
      installUrl: "https://play.google.com/apps/testing/com.mentra.bluetoothsdkexample",
    },
    aab: {
      url: `https://github.com/Mentra-Community/MentraOS/releases/download/${plan.artifactContainerTag}/mentra-example-react-native-${plan.releaseIdentity}.aab`,
      sha256: "8".repeat(64),
      size: 123,
    },
    provenanceUrl,
  }
  return {betaManifest, starterKit, exampleTestflight, exampleGooglePlay}
}

function assemble(plan, overrides = {}) {
  const {betaManifest, starterKit, exampleTestflight, exampleGooglePlay} = fixtures(plan)
  return assembleExampleReleaseResults({
    plan,
    betaManifest,
    betaManifestUrl: `https://github.com/Mentra-Community/MentraOS/releases/download/${plan.artifactContainerTag}/${plan.artifactNames.releaseManifest}`,
    betaManifestSha256: "b".repeat(64),
    starterKit,
    starterKitResultUrl: "https://example.com/starter-kit-result.json",
    exampleTestflight,
    exampleGooglePlay,
    completedAt: "2026-08-25T02:00:00.000Z",
    provenanceUrl,
    ...overrides,
  })
}

test("finalizes the Bluetooth example as its own record against a finalized beta", () => {
  const plan = planFor()
  const record = assemble(plan)

  assert.equal(record.kind, EXAMPLE_RELEASE_KIND)
  assert.equal(record.releaseIdentity, plan.releaseIdentity)
  assert.equal(record.betaManifest.name, plan.artifactNames.releaseManifest)
  assert.equal(record.betaManifest.completedAt, "2026-08-25T01:00:00.000Z")
  assert.equal(record.starterKit.resultUrl, "https://example.com/starter-kit-result.json")
  assert.equal(record.starterKit.testflight.build.id, "build-1")
  assert.equal(record.starterKit.googlePlay.track, "beta")
  assert.deepEqual(
    record.artifacts.map((artifact) => artifact.coordinate),
    fixtures(plan).starterKit.artifacts.map((artifact) => artifact.name),
  )
  assert.equal(exampleReleaseAssetName(plan.releaseIdentity), `mentra-example-release-${plan.releaseIdentity}.json`)
  assert.equal(validateExampleReleaseRecord(record, plan), record)
})

test("the example release cannot be assembled without the finalized beta it was built against", () => {
  const plan = planFor()
  const {betaManifest} = fixtures(plan)
  assert.throws(
    () => assemble(plan, {betaManifest: {...betaManifest, releaseIdentity: `${family.familyBaseVersion}-beta.56`}}),
    /finalized manifest of the same coordinated beta/,
  )
  assert.throws(
    () => assemble(plan, {betaManifest: {...betaManifest, completedAt: undefined}}),
    /finalized manifest of the same coordinated beta/,
  )
  assert.throws(() => assemble(plan, {betaManifestSha256: "nope"}), /SHA-256/)
  assert.throws(() => assemble(plan, {betaManifestUrl: "http://example.com/beta.json"}), /HTTPS/)
})

test("the example release verifies the Starter Kit evidence on its own terms", () => {
  const plan = planFor()
  const {starterKit} = fixtures(plan)
  assert.throws(() => assemble(plan, {starterKit: undefined}), /Starter Kit result does not match the release plan/)
  assert.throws(
    () => assemble(plan, {starterKit: {...starterKit, releaseSetId: "mentra-other"}}),
    /Starter Kit result does not match the release plan/,
  )
  assert.throws(
    () => assemble(plan, {starterKit: {...starterKit, starterKit: {...starterKit.starterKit, baseCommit: "abc"}}}),
    /Starter Kit result does not match the release plan/,
  )
  assert.throws(
    () => assemble(plan, {starterKit: {...starterKit, packages: {"@mentra/bluetooth-sdk": "0.0.0"}}}),
    /version does not match/,
  )
  // Any Starter Kit channel head is acceptable: the Mentra plan no longer pins one.
  const other = {...starterKit, starterKit: {...starterKit.starterKit, baseCommit: "f".repeat(40)}}
  assert.equal(
    verifyStarterKitResult(
      plan,
      other,
      "https://example.com/r.json",
      fixtures(plan).exampleTestflight,
      fixtures(plan).exampleGooglePlay,
    ).record.starterKit.baseCommit,
    "f".repeat(40),
  )
})

function productionFixtures() {
  const betaPlan = planFor("beta")
  const {betaManifest, starterKit, exampleTestflight, exampleGooglePlay} = fixtures(betaPlan)
  const betaManifestUrl = `https://github.com/Mentra-Community/MentraOS/releases/download/${betaPlan.artifactContainerTag}/${betaPlan.artifactNames.releaseManifest}`
  const betaManifestSha256 = "b".repeat(64)
  const plan = createReleasePlan({
    family,
    channel: "production",
    sourceCommit: betaPlan.sourceCommit,
    nativeBuildNumber: familyBuildNumber(family.familyBaseVersion, 58),
  })
  plan.promotion = {
    selectedBetaReleaseSetId: betaPlan.releaseSetId,
    selectedBetaIdentity: betaPlan.releaseIdentity,
    selectedBetaManifest: {url: betaManifestUrl, sha256: betaManifestSha256},
    otaManifest: {url: "https://example.com/ota.json", sha256: "c".repeat(64)},
  }
  plan.example = {
    testflight: {group: "Mentra Bluetooth Example", audience: "external"},
    googlePlay: {track: "Mentra Bluetooth Example Production Candidates"},
    storePromotion: "never",
  }
  const production = {
    starterKit: {
      ...starterKit,
      releaseSetId: plan.releaseSetId,
      releaseIdentity: plan.releaseIdentity,
      channel: "production",
      packages: {
        "@mentra/bluetooth-sdk": `${family.familyBaseVersion}`,
        "@mentra/engine": `${family.familyBaseVersion}`,
      },
      starterKit: {
        ...starterKit.starterKit,
        sourceTag: `sdk-${family.familyBaseVersion}`,
        artifactContainerTag: `sdk-${family.familyBaseVersion}`,
      },
      artifacts: starterKit.artifacts.map((artifact) => ({
        ...artifact,
        name: artifact.name.replace(betaPlan.releaseIdentity, plan.releaseIdentity),
      })),
    },
    exampleTestflight: {
      ...exampleTestflight,
      releaseSetId: plan.releaseSetId,
      releaseIdentity: plan.releaseIdentity,
      channel: "production",
      version: {
        marketingVersion: `${family.familyBaseVersion}`,
        buildNumber: familyBuildNumber(family.familyBaseVersion, 58),
      },
      group: {id: "group-2", name: "Mentra Bluetooth Example"},
      distribution: {
        audience: "external",
        status: "submitted",
        installUrl: "https://testflight.apple.com/join/production123",
        reviewState: "WAITING_FOR_REVIEW",
      },
    },
    exampleGooglePlay: {
      ...exampleGooglePlay,
      releaseSetId: plan.releaseSetId,
      releaseIdentity: plan.releaseIdentity,
      channel: "production",
      version: {
        marketingVersion: `${family.familyBaseVersion}`,
        buildNumber: familyBuildNumber(family.familyBaseVersion, 58),
      },
      track: "Mentra Bluetooth Example Production Candidates",
      distribution: {...exampleGooglePlay.distribution, audience: "internal"},
      aab: {
        ...exampleGooglePlay.aab,
        url: `https://github.com/Mentra-Community/MentraOS/releases/download/${plan.artifactContainerTag}/mentra-example-react-native-${family.familyBaseVersion}.aab`,
      },
    },
  }
  return {plan, betaPlan, betaManifest, betaManifestUrl, betaManifestSha256, ...production}
}

function assembleProduction(overrides = {}) {
  const f = productionFixtures()
  return assembleExampleReleaseResults({
    plan: f.plan,
    betaManifest: f.betaManifest,
    betaManifestUrl: f.betaManifestUrl,
    betaManifestSha256: f.betaManifestSha256,
    starterKit: f.starterKit,
    starterKitResultUrl: "https://example.com/starter-kit-result.json",
    exampleTestflight: f.exampleTestflight,
    exampleGooglePlay: f.exampleGooglePlay,
    completedAt: "2026-08-25T02:00:00.000Z",
    provenanceUrl,
    ...overrides,
  })
}

test("a production example is finalized against the promoted beta's manifest and never a store release", () => {
  const f = productionFixtures()
  const record = assembleProduction()
  assert.equal(record.channel, "production")
  assert.equal(record.releaseIdentity, `${family.familyBaseVersion}`)
  assert.equal(record.native.buildNumber, familyBuildNumber(family.familyBaseVersion, 58))
  assert.equal(record.betaManifest.name, `mentra-release-${f.betaPlan.releaseIdentity}.json`)
  assert.equal(record.promotion.selectedBetaIdentity, f.betaPlan.releaseIdentity)
  assert.equal(record.promotion.storePromotion, "never")
  assert.equal(record.starterKit.testflight.group.name, "Mentra Bluetooth Example")
  assert.equal(record.starterKit.testflight.distribution.audience, "external")
  assert.match(record.starterKit.testflight.distribution.installUrl, /^https:\/\/testflight\.apple\.com\/join\//)
  assert.equal(record.starterKit.googlePlay.track, "Mentra Bluetooth Example Production Candidates")
  assert.equal(record.starterKit.googlePlay.distribution.audience, "internal")
  assert.equal(validateExampleReleaseRecord(record, f.plan), record)
  assert.throws(
    () =>
      validateExampleReleaseRecord({...record, promotion: {...record.promotion, storePromotion: "app-store"}}, f.plan),
    /finalized Mentra Bluetooth example/,
  )
})

test("a production example refuses a manifest, plan, or destination that is not the promoted beta's", () => {
  const f = productionFixtures()
  assert.throws(
    () =>
      assembleProduction({betaManifest: {...f.betaManifest, releaseIdentity: `${family.familyBaseVersion}-beta.56`}}),
    /finalized manifest of the promoted beta/,
  )
  assert.throws(
    () => assembleProduction({betaManifestSha256: "d".repeat(64)}),
    /exact beta manifest the plan was promoted from/,
  )
  assert.throws(
    () => assembleProduction({plan: {...f.plan, example: {...f.plan.example, storePromotion: "app-store"}}}),
    /never promoted to a store/,
  )
  assert.throws(
    () =>
      assembleProduction({
        exampleTestflight: {...f.exampleTestflight, group: {id: "g", name: "Mentra Staging Public"}},
      }),
    /Example TestFlight result does not match/,
  )
  assert.throws(
    () =>
      assembleProduction({
        exampleTestflight: {
          ...f.exampleTestflight,
          distribution: {
            ...f.exampleTestflight.distribution,
            installUrl: "https://appstoreconnect.apple.com/apps/6792839366/testflight/groups/group-2",
          },
        },
      }),
    /public invitation link/,
  )
  assert.throws(
    () => assembleProduction({exampleGooglePlay: {...f.exampleGooglePlay, track: "beta"}}),
    /track does not match/,
  )
  // A skipped review submission is retried, never frozen as the production record.
  assert.throws(
    () =>
      assembleProduction({
        exampleTestflight: {
          ...f.exampleTestflight,
          distribution: {
            ...f.exampleTestflight.distribution,
            status: "skipped",
            skipReason: "external_review_setup_required",
          },
        },
      }),
    /was skipped \(external_review_setup_required\); rerun/,
  )
  assert.equal(
    assembleProduction({
      exampleTestflight: {
        ...f.exampleTestflight,
        distribution: {...f.exampleTestflight.distribution, status: "available", reviewState: "APPROVED"},
      },
    }).starterKit.testflight.distribution.status,
    "available",
  )
})

test("validation rejects records that do not describe a finalized example", () => {
  const plan = planFor()
  const record = assemble(plan)
  assert.throws(
    () => validateExampleReleaseRecord({...record, kind: "other"}, plan),
    /finalized Mentra Bluetooth example/,
  )
  assert.throws(
    () => validateExampleReleaseRecord({...record, artifacts: []}, plan),
    /finalized Mentra Bluetooth example/,
  )
  assert.throws(
    () => validateExampleReleaseRecord({...record, betaManifest: {...record.betaManifest, sha256: "x"}}, plan),
    /finalized Mentra Bluetooth example/,
  )
})

test("a rerun reconciles its re-observed candidates against the published production record", () => {
  const f = productionFixtures()
  const record = assembleProduction()
  const rerun = {
    plan: f.plan,
    record,
    starterKit: f.starterKit,
    exampleTestflight: {
      ...f.exampleTestflight,
      build: {...f.exampleTestflight.build, uploadStatus: "reused"},
      ipa: undefined,
      provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/999",
    },
    exampleGooglePlay: {
      ...f.exampleGooglePlay,
      uploadStatus: "reused",
      provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/999",
    },
  }
  assert.equal(reconcileExampleReleaseRecord(rerun), record)
  assert.throws(
    () =>
      reconcileExampleReleaseRecord({
        ...rerun,
        exampleTestflight: {...rerun.exampleTestflight, build: {...rerun.exampleTestflight.build, id: "build-9"}},
      }),
    /TestFlight build id/,
  )
  assert.throws(
    () =>
      reconcileExampleReleaseRecord({
        ...rerun,
        starterKit: {...f.starterKit, starterKit: {...f.starterKit.starterKit, releaseCommit: "9".repeat(40)}},
      }),
    /Starter Kit release commit/,
  )
  assert.throws(
    () =>
      reconcileExampleReleaseRecord({
        ...rerun,
        exampleGooglePlay: {...rerun.exampleGooglePlay, aab: {...rerun.exampleGooglePlay.aab, sha256: "7".repeat(64)}},
      }),
    /Google Play bundle digest/,
  )
})

test("redispatching a historical example preserves its complete GitHub record", (t) => {
  const plan = planFor()
  const f = fixtures(plan)
  const record = assemble(plan)
  const original = JSON.stringify(record, null, 2) + "\n"
  const directory = mkdtempSync(path.join(tmpdir(), "legacy-example-retry-"))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  symlinkSync(path.join(rootDir, ".github"), path.join(directory, ".github"), "dir")
  const write = (file, contents) => {
    mkdirSync(path.dirname(path.join(directory, file)), {recursive: true})
    writeFileSync(path.join(directory, file), contents)
  }
  write("release-input/plan/release-plan.json", JSON.stringify(plan))
  write(`release-input/finalized/${plan.artifactNames.releaseManifest}`, JSON.stringify(f.betaManifest))
  write("release-input/starter-kit/starter-kit-release-test.json", JSON.stringify(f.starterKit))
  write(
    "release-input/example-testflight/example-testflight-publication.json",
    JSON.stringify({...f.exampleTestflight, build: {...f.exampleTestflight.build, uploadStatus: "reused"}}),
  )
  // A retry now observes the mirrored CDN URL, while the frozen record keeps
  // the old GitHub AAB URL and the first run's timestamp/provenance.
  const observed = {
    ...f.exampleGooglePlay,
    uploadStatus: "reused",
    aab: {
      ...f.exampleGooglePlay.aab,
      url: f.exampleGooglePlay.aab.url
        .replace("https://github.com/", "https://artifactscdn.mentraglass.com/")
        .replace("/releases/download/", "/releases/"),
    },
  }
  write("release-input/example-google-play/example-google-play-publication.json", JSON.stringify(observed))
  write("legacy.json", original)
  const recordName = exampleReleaseAssetName(plan.releaseIdentity)
  const recordUrl = `https://github.com/Mentra-Community/MentraOS/releases/download/${plan.artifactContainerTag}/${recordName}`
  mkdirSync(path.join(directory, "bin"))
  writeFileSync(
    path.join(directory, "bin/node"),
    `#!${process.execPath}\n
const {execFileSync} = require('node:child_process');
const {readFileSync, realpathSync} = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== '.github/scripts/release-assets.mjs') {
  execFileSync(process.execPath, [realpathSync(args[0]), ...args.slice(1)], {stdio: 'inherit'});
} else if (args[1] === 'list') {
  console.log(JSON.stringify([{id: 123, name: ${JSON.stringify(recordName)}, state: 'uploaded'}]));
} else if (args[1] === 'fetch') {
  process.stdout.write(readFileSync('legacy.json'));
} else if (args[1] === 'url') {
  console.log(${JSON.stringify(recordUrl)});
} else { throw Error('Unexpected artifact command'); }
`,
    {mode: 0o755},
  )
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/coordinated-example-release.yml"), "utf8")
  const step = workflow
    .split("      - name: Assemble the example release record against the finalized beta\n")[1]
    .split("\n      - name:")[0]
  const script = step
    .split("        run: |\n")[1]
    .replace(/^          /gm, "")
    .replace(/\$\{\{.*?\}\}/g, "unused")
  const run = () =>
    execFileSync("bash", ["-c", script], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}/bin:${process.env.PATH}`,
        GITHUB_OUTPUT: path.join(directory, "outputs"),
        GITHUB_REPOSITORY: "Mentra-Community/MentraOS",
        GITHUB_RUN_ID: "999",
      },
      stdio: "pipe",
    })
  run()
  assert.equal(readFileSync(path.join(directory, "finalized-example", recordName), "utf8"), original)
  const outputs = readFileSync(path.join(directory, "outputs"), "utf8")
  assert.match(outputs, /published=true/)
  assert.ok(outputs.includes(`record_url=${recordUrl}`))
  write(
    "release-input/example-google-play/example-google-play-publication.json",
    JSON.stringify({...observed, aab: {...observed.aab, sha256: "f".repeat(64)}}),
  )
  assert.throws(run, /Google Play bundle digest/)
})
