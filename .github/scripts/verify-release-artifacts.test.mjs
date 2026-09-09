import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import test from "node:test"

import {verifyReleaseArtifacts} from "./verify-release-artifacts.mjs"

const bytes = Buffer.from("immutable artifact")
const sha256 = createHash("sha256").update(bytes).digest("hex")

test("verifies every downloadable package and artifact while excluding store console links", async () => {
  const requested = []
  const manifest = {
    otaManifest: {coordinate: "ota", url: "https://example.com/ota", sha256},
    artifacts: [{coordinate: "apk", url: "https://example.com/apk", sha256}],
    publications: {
      "@mentra/engine": {npm: {coordinate: "engine", url: "https://example.com/engine", sha256}},
      "mentraos": {"google-play": {coordinate: "play", url: "https://play.google.com/console/", sha256}},
    },
  }
  const result = await verifyReleaseArtifacts(manifest, async (url) => {
    requested.push(url.toString())
    return new Response(bytes)
  })
  assert.equal(result.length, 3)
  assert.equal(requested.includes("https://play.google.com/console/"), false)
})

test("rejects bytes that no longer match the completed manifest", async () => {
  await assert.rejects(
    () =>
      verifyReleaseArtifacts(
        {otaManifest: {coordinate: "ota", url: "https://example.com/ota", sha256: "0".repeat(64)}},
        async () => new Response(bytes),
      ),
    /no longer matches/,
  )
})

test("rejects credentialed release artifact URLs before fetching", async () => {
  await assert.rejects(
    () =>
      verifyReleaseArtifacts(
        {otaManifest: {coordinate: "ota", url: "https://token@example.com/ota", sha256}},
        async () => {
          throw new Error("must not fetch")
        },
      ),
    /credential-free HTTPS/,
  )
})
