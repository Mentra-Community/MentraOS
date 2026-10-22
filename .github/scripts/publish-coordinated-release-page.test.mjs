import assert from "node:assert/strict"
import test from "node:test"

import {finalizedBeta} from "./coordinated-release-test-helpers.mjs"
import {exampleArtifacts} from "./bluetooth-example-artifacts.mjs"
import {
  publishCoordinatedReleasePage,
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

test("the one dev or beta page writer lists the OTA bundle, and the example apps when they were published", () => {
  const input = fixture()
  const without = releaseDownloadNotes(input)
  const bundle = input.manifest.artifacts.find((a) => a.coordinate === input.plan.artifactNames.otaBundle)
  assert.ok(without.includes(`[Glasses OTA bundle](${bundle.url})`))
  assert.doesNotMatch(without, /Bluetooth example apps/)

  const withExamples = releaseDownloadNotes({...input, examples: true})
  const examples = exampleArtifacts(input.plan, input.repository)
  assert.match(withExamples, /## Bluetooth example apps/)
  for (const {url} of examples) assert.ok(withExamples.includes(`](${url})`), url)
  assert.ok(
    withExamples.includes(
      `[React Native example APK](https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/${input.plan.artifactContainerTag}/mentra-example-react-native-${input.plan.releaseIdentity}.apk)`,
    ),
  )
  // One managed block: a rerun of the same page writer replaces it in place.
  const page = fixture({id: 42, draft: false, prerelease: true, body: updateDownloadNotes("Manual notes", without)})
  publishCoordinatedReleasePage({...page, examples: true})
  const body = page.writes[0].data.body
  assert.ok(body.startsWith("Manual notes\n\n"))
  assert.equal(body.match(/mentra-release-downloads:start/g).length, 1)
  assert.match(body, /## Bluetooth example apps/)
})

test("the production page lists the example apps found in the stable container", () => {
  const {plan: beta} = fixture()
  const identity = beta.familyBaseVersion
  const plan = {
    ...beta,
    channel: "production",
    releaseIdentity: identity,
    releaseSetId: `mentra-${identity}`,
    artifactContainerTag: `mentra-v${identity}`,
    artifactNames: {
      ...beta.artifactNames,
      releaseManifest: `mentra-release-${identity}.json`,
      otaManifest: `mentra-live-ota-${identity}.json`,
      otaBundle: `mentra-live-ota-bundle-${identity}.zip`,
    },
  }
  const manifest = {
    kind: "mentra-production-release",
    releaseIdentity: identity,
    sourceCommit: plan.sourceCommit,
    promotion: {selectedBetaIdentity: beta.releaseIdentity},
    artifacts: [
      {coordinate: plan.artifactNames.otaManifest, url: "https://example.com/ota.json"},
      {coordinate: plan.artifactNames.otaBundle, url: "https://example.com/bundle.zip"},
    ],
  }
  const writes = []
  const api = (route, options = {}) => {
    if (options.method) {
      writes.push(options.data)
      return {id: 7, ...options.data}
    }
    return {id: 7, tag_name: plan.artifactContainerTag, draft: true, prerelease: false, body: ""}
  }
  const [reactNative, android] = exampleArtifacts(plan, "Mentra-Community/MentraOS")
  publishProductionReleasePage({
    plan,
    manifest,
    repository: "Mentra-Community/MentraOS",
    releaseId: "7",
    assetNames: [reactNative.name, plan.artifactNames.otaBundle],
    api,
  })
  const body = writes[0].body
  // GitHub untags a draft whose update omits tag_name; the page keeps it.
  assert.equal(writes[0].tag_name, plan.artifactContainerTag)
  assert.ok(body.includes("[Glasses OTA bundle](https://example.com/bundle.zip)"))
  assert.ok(body.includes(`[React Native example APK](${reactNative.url})`))
  assert.ok(!body.includes(android.url), "Only the examples the container holds are listed")
  assert.equal(body.match(/mentra-release-downloads:start/g).length, 1)
  writes.length = 0
  publishProductionReleasePage({plan, manifest, repository: "Mentra-Community/MentraOS", releaseId: "7", api})
  assert.doesNotMatch(writes[0].body, /Bluetooth example apps/)
})

test("updating a draft production page keeps its tag; a published page sends only the body", () => {
  const {plan: beta} = fixture()
  const identity = beta.familyBaseVersion
  const plan = {
    ...beta,
    channel: "production",
    releaseIdentity: identity,
    releaseSetId: `mentra-${identity}`,
    artifactContainerTag: `mentra-v${identity}`,
    artifactNames: {
      ...beta.artifactNames,
      releaseManifest: `mentra-release-${identity}.json`,
      otaManifest: `mentra-live-ota-${identity}.json`,
      otaBundle: `mentra-live-ota-bundle-${identity}.zip`,
    },
  }
  const manifest = {
    kind: "mentra-production-release",
    releaseIdentity: identity,
    sourceCommit: plan.sourceCommit,
    promotion: {selectedBetaIdentity: beta.releaseIdentity},
    artifacts: [
      {coordinate: plan.artifactNames.otaManifest, url: "https://example.com/ota.json"},
      {coordinate: plan.artifactNames.otaBundle, url: "https://example.com/bundle.zip"},
    ],
  }
  for (const draft of [true, false]) {
    const writes = []
    const api = (route, options = {}) => {
      if (options.method) {
        writes.push(options.data)
        return {id: 7, ...options.data}
      }
      return {id: 7, tag_name: plan.artifactContainerTag, draft, prerelease: false, body: "Notes"}
    }
    publishProductionReleasePage({plan, manifest, repository: "Mentra-Community/MentraOS", releaseId: "7", api})
    assert.equal(writes.length, 1)
    assert.deepEqual(Object.keys(writes[0]).sort(), draft ? ["body", "tag_name"] : ["body"])
    if (draft) assert.equal(writes[0].tag_name, `mentra-v${identity}`)
  }
})
