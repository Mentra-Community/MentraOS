import assert from "node:assert/strict"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {inspectDeployment, publishDeployment, uploadManagedDeployment} from "./sonatype-central-deployment.mjs"

const deploymentId = "28570f16-da32-4c14-bd2e-c1acc0782365"
const deploymentName = "mentra-3.1.0-beta.57-android-sdk"
const expectedPurls = [
  "pkg:maven/com.mentraglass/bluetooth-sdk@3.1.0-beta.57",
  "pkg:maven/com.mentraglass/lc3Lib@3.1.0-beta.57",
]

function bundle() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "central-bundle-")), "bundle.zip")
  writeFileSync(file, "bundle")
  return file
}

function record() {
  return {
    schemaVersion: 1,
    deploymentId,
    deploymentName,
    bundleSha256: "a".repeat(64),
    expectedPurls,
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {status})
}

test("uploads a user-managed deployment and returns a durable recovery record", async () => {
  let request
  const result = await uploadManagedDeployment({
    bundle: bundle(),
    token: "token",
    deploymentName,
    expectedPurls,
    fetchImpl: async (url, options) => {
      request = {url: String(url), options}
      return new Response(deploymentId, {status: 201})
    },
  })

  assert.match(request.url, /publishingType=USER_MANAGED/)
  assert.match(request.url, /name=mentra-3.1.0-beta.57-android-sdk/)
  assert.equal(request.options.method, "POST")
  assert.equal(result.deploymentId, deploymentId)
  assert.equal(result.bundleSha256.length, 64)
  assert.deepEqual(result.expectedPurls, expectedPurls)
})

test("publishes a persisted deployment only after validation", async () => {
  const states = ["PENDING", "VALIDATED", "VALIDATED", "PUBLISHING", "PUBLISHED"]
  let publicationRequests = 0
  const result = await publishDeployment({
    record: record(),
    token: "token",
    fetchImpl: async (url) => {
      if (String(url).includes(`/deployment/${deploymentId}`)) {
        publicationRequests += 1
        return new Response(null, {status: 204})
      }
      const deploymentState = states.shift()
      return jsonResponse({
        deploymentId,
        deploymentName,
        deploymentState,
        purls: deploymentState === "PUBLISHED" ? expectedPurls : [],
      })
    },
    sleepImpl: async () => {},
  })

  assert.equal(publicationRequests, 1)
  assert.equal(result.deploymentState, "PUBLISHED")
})

test("resumes a publishing deployment without sending another publication request", async () => {
  const states = ["PUBLISHING", "PUBLISHED"]
  let publicationRequests = 0
  await publishDeployment({
    record: record(),
    token: "token",
    fetchImpl: async (url) => {
      if (String(url).includes(`/deployment/${deploymentId}`)) publicationRequests += 1
      const deploymentState = states.shift()
      return jsonResponse({deploymentId, deploymentName, deploymentState, purls: expectedPurls})
    },
    sleepImpl: async () => {},
  })
  assert.equal(publicationRequests, 0)
})

test("replaces a persisted deployment only after Sonatype reports it failed", async () => {
  const failed = await inspectDeployment({
    record: record(),
    token: "token",
    fetchImpl: async () =>
      jsonResponse({deploymentId, deploymentName, deploymentState: "FAILED", errors: ["invalid signature"]}),
  })
  assert.equal(failed.disposition, "replace")
  assert.deepEqual(failed.errors, ["invalid signature"])

  const publishing = await inspectDeployment({
    record: record(),
    token: "token",
    fetchImpl: async () => jsonResponse({deploymentId, deploymentName, deploymentState: "PUBLISHING"}),
  })
  assert.equal(publishing.disposition, "resume")
})

test("rejects a published deployment with the wrong Maven coordinates", async () => {
  await assert.rejects(
    publishDeployment({
      record: record(),
      token: "token",
      fetchImpl: async () =>
        jsonResponse({deploymentId, deploymentName, deploymentState: "PUBLISHED", purls: [expectedPurls[0]]}),
      sleepImpl: async () => {},
    }),
    /missing expected components/,
  )
})
