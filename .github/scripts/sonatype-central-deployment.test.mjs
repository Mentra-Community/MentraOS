import assert from "node:assert/strict"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {inspectDeployment, uploadDeployment} from "./sonatype-central-deployment.mjs"

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

test("uploads an automatically published deployment and returns a durable recovery record", async () => {
  let request
  const result = await uploadDeployment({
    bundle: bundle(),
    token: "token",
    deploymentName,
    expectedPurls,
    fetchImpl: async (url, options) => {
      request = {url: String(url), options}
      return new Response(deploymentId, {status: 201})
    },
  })

  assert.match(request.url, /publishingType=AUTOMATIC/)
  assert.match(request.url, /name=mentra-3.1.0-beta.57-android-sdk/)
  assert.equal(request.options.method, "POST")
  assert.equal(result.deploymentId, deploymentId)
  assert.equal(result.bundleSha256.length, 64)
  assert.deepEqual(result.expectedPurls, expectedPurls)
  assert.equal(result.publishingType, "AUTOMATIC")
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

test("resumes a published deployment when status PURLs are incomplete", async () => {
  const result = await inspectDeployment({
    record: record(),
    token: "token",
    fetchImpl: async () =>
      jsonResponse({deploymentId, deploymentName, deploymentState: "PUBLISHED", purls: [expectedPurls[0]]}),
  })

  assert.equal(result.disposition, "resume")
  assert.deepEqual(result.purls, [expectedPurls[0]])
})
