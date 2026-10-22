import assert from "node:assert/strict"
import test from "node:test"

import {finalizedBeta} from "./coordinated-release-test-helpers.mjs"
import {
  exampleDownloadNotes,
  publishCoordinatedReleasePage,
  publishExampleDownloads,
  publishProductionReleasePage,
  releaseDownloadNotes,
  updateDownloadNotes,
} from "./publish-coordinated-release-page.mjs"

function fixture(existing = null) {
  const input = finalizedBeta()
  const writes = []
  return {
    ...input,
    writes,
    api: (route, options = {}) => {
      if (options.method) {
        writes.push({route, ...options})
        return {...options.data, html_url: "https://github.com/release"}
      }
      if (route.includes("git/ref/tags/")) return {object: {type: "commit", sha: input.plan.sourceCommit}}
      return existing
    },
  }
}

test("creates a prerelease page at the completed source tag with exact mobile download URLs", () => {
  const input = fixture()
  publishCoordinatedReleasePage(input)
  assert.equal(input.writes.length, 1)
  const {data} = input.writes[0]
  assert.equal(data.tag_name, `mentra-v${input.plan.releaseIdentity}`)
  assert.equal(data.target_commitish, input.plan.sourceCommit)
  assert.equal(data.prerelease, true)
  assert.equal(data.make_latest, "false")
  for (const key of ["androidApp", "androidStoreApp", "iosApp"]) {
    const asset = input.manifest.artifacts.find((a) => a.coordinate === input.plan.artifactNames[key])
    assert.ok(data.body.includes(`](${asset.url})`))
  }
  assert.match(data.body, /Android phone APK — install the Mentra App/)
})

test("repairs an existing page without changing manual notes or release metadata", () => {
  const input = fixture({id: 42, draft: false, prerelease: true, body: "Manual notes"})
  publishCoordinatedReleasePage(input)
  const write = input.writes[0]
  assert.equal(write.method, "PATCH")
  assert.deepEqual(Object.keys(write.data), ["body"])
  assert.ok(write.data.body.startsWith("Manual notes\n\n"))
  const retry = fixture({id: 42, draft: false, prerelease: true, body: write.data.body})
  publishCoordinatedReleasePage(retry)
  assert.equal(retry.writes.length, 0)
})

test("refuses a mismatched source tag, incomplete release, production plan, or draft", () => {
  const wrongTag = fixture()
  wrongTag.api = () => ({object: {type: "commit", sha: "f".repeat(40)}})
  assert.throws(() => publishCoordinatedReleasePage(wrongTag), /completed source/)
  const incomplete = fixture()
  incomplete.manifest.artifacts.pop()
  assert.throws(() => publishCoordinatedReleasePage(incomplete), /Missing required artifact/)
  assert.equal(incomplete.writes.length, 0)
  const production = fixture()
  production.plan.releaseIdentity = production.plan.familyBaseVersion
  assert.throws(() => publishCoordinatedReleasePage(production), /development and beta/)
  assert.throws(() => publishCoordinatedReleasePage(fixture({draft: true})), /draft/)
})

test("managed notes are replaceable and preserve surrounding content", () => {
  const input = fixture()
  const notes = releaseDownloadNotes(input)
  const body = updateDownloadNotes("Before", notes) + "After"
  assert.equal(updateDownloadNotes(body, notes), body)
  assert.throws(() => updateDownloadNotes("<!-- mentra-release-downloads:start -->", notes), /Malformed/)
})

test("a failed page publication can retry the same archived manifest without changing its bytes", () => {
  const input = fixture()
  const before = JSON.stringify({plan: input.plan, manifest: input.manifest})
  const api = input.api
  let failed = false
  input.api = (route, options) => {
    if (options?.method === "POST" && !failed) {
      failed = true
      throw new Error("GitHub temporarily unavailable")
    }
    return api(route, options)
  }
  assert.throws(() => publishCoordinatedReleasePage(input), /temporarily unavailable/)
  assert.equal(JSON.stringify({plan: input.plan, manifest: input.manifest}), before)
  publishCoordinatedReleasePage(input)
  assert.equal(input.writes.length, 1)
  assert.equal(JSON.stringify({plan: input.plan, manifest: input.manifest}), before)
})

function publishedExamples(plan) {
  return {
    schemaVersion: 1,
    kind: "mentra-bluetooth-examples-build",
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    sourceCommit: plan.sourceCommit,
    otaManifest: {url: "https://example.com/ota.json", sha256: "c".repeat(64)},
    artifacts: [
      ["android", "mentra-example-android", ".apk"],
      ["ios", "mentra-example-ios", "-unsigned.ipa"],
      ["reactNative", "mentra-example-react-native", ".apk"],
      ["reactNativeElevenLabsAudio", "mentra-example-rn-elevenlabs-audio", ".apk"],
    ].map(([key, prefix, suffix]) => ({
      key,
      name: `${prefix}-${plan.releaseIdentity}${suffix}`,
      sha256: "d".repeat(64),
      size: 1,
      status: "published",
      url: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/${plan.artifactContainerTag}/${prefix}-${plan.releaseIdentity}${suffix}`,
    })),
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
  }
}

// A minimal in-memory release that records every body update.
function releaseApi(release) {
  const writes = []
  const api = (route, options = {}) => {
    if (options.method) {
      writes.push({route, ...options})
      Object.assign(release, options.data)
      return {...release}
    }
    if (route.includes("git/ref/tags/")) return {object: {type: "commit", sha: release.sourceCommit}}
    return {...release}
  }
  return {api, writes, release}
}

test("the beta page lists its OTA bundle, and the example apps in a block republishing keeps", () => {
  const input = fixture()
  const notes = releaseDownloadNotes(input)
  const bundle = input.manifest.artifacts.find((a) => a.coordinate === input.plan.artifactNames.otaBundle)
  assert.ok(notes.includes(`[Glasses OTA bundle](${bundle.url})`))
  assert.doesNotMatch(notes, /## Bluetooth example apps/)

  const examples = publishedExamples(input.plan)
  const {api, writes, release} = releaseApi({
    id: 42,
    draft: false,
    prerelease: true,
    body: "Manual notes",
    sourceCommit: input.plan.sourceCommit,
  })
  publishCoordinatedReleasePage({...input, api})
  publishExampleDownloads({plan: input.plan, examples, repository: input.repository, api})
  assert.equal(writes.at(-1).route, "repos/Mentra-Community/MentraOS/releases/42")
  assert.ok(release.body.includes(`[React Native example APK](${examples.artifacts[2].url})`))
  assert.ok(release.body.includes(`[Native iOS example IPA (unsigned)](${examples.artifacts[1].url})`))
  // Republishing the release downloads keeps the example block, and the
  // examples republished with the same input change nothing.
  const withExamples = release.body
  publishCoordinatedReleasePage({...input, api})
  assert.equal(release.body, withExamples)
  const count = writes.length
  publishExampleDownloads({plan: input.plan, examples, repository: input.repository, api})
  assert.equal(writes.length, count)
  assert.ok(release.body.startsWith("Manual notes\n\n"))
  assert.throws(
    () => exampleDownloadNotes({plan: input.plan, examples: {...examples, sourceCommit: "f".repeat(40)}}),
    /do not match the release plan/,
  )
})

test("the production release lists its example apps and keeps them when its downloads are republished", () => {
  const {plan: beta} = fixture()
  const plan = {
    ...beta,
    channel: "production",
    releaseIdentity: beta.familyBaseVersion,
    releaseSetId: `mentra-${beta.familyBaseVersion}`,
    artifactContainerTag: `mentra-v${beta.familyBaseVersion}`,
    artifactNames: {
      ...beta.artifactNames,
      releaseManifest: `mentra-release-${beta.familyBaseVersion}.json`,
      otaManifest: `mentra-live-ota-${beta.familyBaseVersion}.json`,
      otaBundle: `mentra-live-ota-bundle-${beta.familyBaseVersion}.zip`,
    },
  }
  const examples = publishedExamples(plan)
  const {api, release} = releaseApi({
    id: 7,
    tag_name: plan.artifactContainerTag,
    draft: true,
    prerelease: false,
    body: "Canonical production release records.",
  })
  // The production example usually runs before the rollout completes.
  publishExampleDownloads({plan, examples, repository: "Mentra-Community/MentraOS", releaseId: "7", api})
  assert.match(release.body, /## Bluetooth example apps/)
  assert.ok(release.body.includes(`[React Native example APK](${examples.artifacts[2].url})`))
  const manifest = {
    kind: "mentra-production-release",
    releaseIdentity: plan.releaseIdentity,
    sourceCommit: plan.sourceCommit,
    promotion: {selectedBetaIdentity: beta.releaseIdentity},
    artifacts: [
      {coordinate: plan.artifactNames.otaManifest, url: "https://example.com/ota.json"},
      {coordinate: plan.artifactNames.otaBundle, url: "https://example.com/bundle.zip"},
    ],
  }
  publishProductionReleasePage({plan, manifest, repository: "Mentra-Community/MentraOS", releaseId: "7", api})
  assert.match(release.body, /## Bluetooth example apps/)
  assert.ok(release.body.includes("[Glasses OTA bundle](https://example.com/bundle.zip)"))
  assert.equal(release.draft, true, "The stable release is never published here")
  assert.throws(
    () => publishExampleDownloads({plan, examples, repository: "Mentra-Community/MentraOS", releaseId: "7",
      api: () => ({id: 7, tag_name: "mentra-v9.9.9", prerelease: false})}),
    /production container/,
  )
})
