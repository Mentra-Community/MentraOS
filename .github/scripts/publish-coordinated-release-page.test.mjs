import assert from "node:assert/strict"
import test from "node:test"

import {finalizedBeta} from "./coordinated-release-test-helpers.mjs"
import {
  publishCoordinatedReleasePage,
  releaseDownloadNotes,
  updateDownloadNotes,
} from "./publish-coordinated-release-page.mjs"

const missing = () => Object.assign(new Error("Not Found"), {status: 404})

function fixture(existing = null) {
  const input = finalizedBeta()
  const writes = []
  const delays = []
  return {
    ...input,
    writes,
    delays,
    wait: async (delay) => delays.push(delay),
    log: () => {},
    api: (route, options = {}) => {
      if (options.method) {
        writes.push({route, ...options})
        return {id: 7, ...options.data, html_url: "https://github.com/release"}
      }
      if (route.includes("git/ref/tags/")) return {object: {type: "commit", sha: input.plan.sourceCommit}}
      if (!existing) throw missing()
      return existing
    },
  }
}

test("creates a prerelease page at the completed source tag with exact mobile download URLs", async () => {
  const input = fixture()
  await publishCoordinatedReleasePage(input)
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

test("repairs an existing page without changing manual notes or release metadata", async () => {
  const input = fixture({id: 42, draft: false, prerelease: true, body: "Manual notes"})
  await publishCoordinatedReleasePage(input)
  const write = input.writes[0]
  assert.equal(write.method, "PATCH")
  assert.deepEqual(Object.keys(write.data), ["body"])
  assert.ok(write.data.body.startsWith("Manual notes\n\n"))
  const retry = fixture({id: 42, draft: false, prerelease: true, body: write.data.body})
  await publishCoordinatedReleasePage(retry)
  assert.equal(retry.writes.length, 0)
})

test("refuses a mismatched source tag, incomplete release, production plan, or draft", async () => {
  const wrongTag = fixture()
  wrongTag.api = () => ({object: {type: "commit", sha: "f".repeat(40)}})
  await assert.rejects(publishCoordinatedReleasePage(wrongTag), /completed source/)
  const incomplete = fixture()
  incomplete.manifest.artifacts.pop()
  await assert.rejects(publishCoordinatedReleasePage(incomplete), /Missing required artifact/)
  assert.equal(incomplete.writes.length, 0)
  const production = fixture()
  production.plan.releaseIdentity = production.plan.familyBaseVersion
  await assert.rejects(publishCoordinatedReleasePage(production), /development and beta/)
  await assert.rejects(publishCoordinatedReleasePage(fixture({draft: true})), /draft/)
})

test("managed notes are replaceable and preserve surrounding content", () => {
  const input = fixture()
  const notes = releaseDownloadNotes(input)
  const body = updateDownloadNotes("Before", notes) + "After"
  assert.equal(updateDownloadNotes(body, notes), body)
  assert.throws(() => updateDownloadNotes("<!-- mentra-release-downloads:start -->", notes), /Malformed/)
})

test("a failed page publication can retry the same archived manifest without changing its bytes", async () => {
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
  await assert.rejects(publishCoordinatedReleasePage(input), /temporarily unavailable/)
  assert.equal(JSON.stringify({plan: input.plan, manifest: input.manifest}), before)
  await publishCoordinatedReleasePage(input)
  assert.equal(input.writes.length, 1)
  assert.equal(JSON.stringify({plan: input.plan, manifest: input.manifest}), before)
})

// Staging run 39991316447 failed here: GitHub's workflow-file check for the
// release timed out and was reported as a 403.
test("retries a page creation denied by an incomplete workflow-file check", async () => {
  const input = fixture()
  const api = input.api
  let denied = false
  input.api = (route, options) => {
    if (options?.method === "POST" && !denied) {
      denied = true
      throw Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
        acceptedPermissions: "contents=write; contents=write,workflows=write",
      })
    }
    return api(route, options)
  }
  const release = await publishCoordinatedReleasePage(input)
  assert.equal(release.tag_name, `mentra-v${input.plan.releaseIdentity}`)
  assert.deepEqual(input.delays, [5000])
  assert.equal(input.writes.filter((write) => write.method === "POST").length, 1)
  assert.equal(input.writes.filter((write) => write.method === "PATCH").length, 0)
})
