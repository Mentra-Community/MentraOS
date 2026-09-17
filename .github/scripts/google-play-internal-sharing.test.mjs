import assert from "node:assert/strict"
import {generateKeyPairSync} from "node:crypto"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  normalizeInternalSharingArtifact,
  serviceAccountAssertion,
  uploadInternalSharingBundle,
} from "./google-play-internal-sharing.mjs"

const keys = generateKeyPairSync("rsa", {modulusLength: 1024})
const credentials = {
  client_email: "release@example.iam.gserviceaccount.com",
  private_key: keys.privateKey.export({type: "pkcs8", format: "pem"}),
  token_uri: "https://oauth2.googleapis.com/token",
}

test("creates a bounded Android Publisher service-account assertion", () => {
  const parts = serviceAccountAssertion(credentials, 1000).split(".")
  assert.equal(parts.length, 3)
  const claims = JSON.parse(Buffer.from(parts[1], "base64url"))
  assert.equal(claims.iat, 1000)
  assert.equal(claims.exp, 4600)
  assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher")
})

test("refuses to send a signed assertion to a credential-supplied endpoint", () => {
  assert.throws(
    () => serviceAccountAssertion({...credentials, token_uri: "https://attacker.example/token"}),
    /official OAuth endpoint/,
  )
})

test("uploads a bundle only to Google Play internal app sharing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "internal-sharing-"))
  const bundle = path.join(root, "app.aab")
  writeFileSync(bundle, "bundle")
  const calls = []
  const artifact = await uploadInternalSharingBundle({
    credentials,
    packageName: "com.mentra.mentra",
    bundle,
    fetchImpl: async (url, options) => {
      calls.push({url, options})
      if (calls.length === 1) return new Response(JSON.stringify({access_token: "masked"}), {status: 200})
      return new Response(
        JSON.stringify({
          downloadUrl: "https://play.google.com/apps/test/example",
          sha256: "a".repeat(64),
          certificateFingerprint: "AA:BB",
        }),
        {status: 200},
      )
    },
  })
  assert.equal(artifact.sha256, "a".repeat(64))
  assert.match(calls[1].url, /applications\/internalappsharing\/com\.mentra\.mentra\/artifacts\/bundle/)
  assert.equal(calls[1].url.includes("edits"), false)
})

test("keeps the download link and describes Play's artifact evidence without failing on its shape", () => {
  const lines = []
  const artifact = normalizeInternalSharingArtifact(
    {downloadUrl: "https://play.google.com/apps/test/example", sha256: "A".repeat(64)},
    (line) => lines.push(line),
  )
  assert.deepEqual(artifact, {
    downloadUrl: "https://play.google.com/apps/test/example",
    sha256: "a".repeat(64),
    certificateFingerprint: "",
  })
  assert.match(lines[0], /host=play\.google\.com sha256=hex64 certificateFingerprint=absent/)
  const odd = normalizeInternalSharingArtifact({downloadUrl: "https://play.google.com/x", sha256: "short"}, () => {})
  assert.equal(odd.sha256, "short")
  assert.throws(() => normalizeInternalSharingArtifact({sha256: "a".repeat(64)}, () => {}), /no HTTPS download URL/)
  assert.throws(() => normalizeInternalSharingArtifact({downloadUrl: "http://play.google.com/x"}, () => {}), /HTTPS/)
})
