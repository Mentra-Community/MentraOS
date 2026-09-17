#!/usr/bin/env node
import {createSign} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

function base64url(value) {
  return Buffer.from(value).toString("base64url")
}

export function serviceAccountAssertion(credentials, now = Math.floor(Date.now() / 1000)) {
  if (credentials.token_uri && credentials.token_uri !== "https://oauth2.googleapis.com/token") {
    throw new Error("Google service-account token_uri must use the official OAuth endpoint")
  }
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(credentials.client_email || "")) {
    throw new Error("Google service-account client_email is invalid")
  }
  if (!/^-----BEGIN PRIVATE KEY-----/.test(credentials.private_key || "")) {
    throw new Error("Google service-account private_key is invalid")
  }
  const header = base64url(JSON.stringify({alg: "RS256", typ: "JWT"}))
  const claims = base64url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )
  const unsigned = `${header}.${claims}`
  const signer = createSign("RSA-SHA256")
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${signer.sign(credentials.private_key, "base64url")}`
}

export async function uploadInternalSharingBundle({
  credentials,
  packageName,
  bundle,
  fetchImpl = fetch,
  log = console.log,
}) {
  const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(credentials),
    }),
  })
  if (!tokenResponse.ok) throw new Error(`Google OAuth token request failed with HTTP ${tokenResponse.status}`)
  const token = await tokenResponse.json()
  if (!token.access_token) throw new Error("Google OAuth response has no access token")
  const url = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/internalappsharing/${encodeURIComponent(packageName)}/artifacts/bundle?uploadType=media`
  const uploadResponse = await fetchImpl(url, {
    method: "POST",
    headers: {"authorization": `Bearer ${token.access_token}`, "content-type": "application/octet-stream"},
    body: readFileSync(bundle),
  })
  if (!uploadResponse.ok)
    throw new Error(`Google Play internal sharing upload failed with HTTP ${uploadResponse.status}`)
  return normalizeInternalSharingArtifact(await uploadResponse.json(), log)
}

// Play documents downloadUrl, sha256 (lowercase hex of the artifact) and
// certificateFingerprint on the artifact. The download link is what the
// record needs; the digest and fingerprint are Play's own evidence about the
// artifact it generated, so they are kept as reported (digest lowercased) and
// described in the log rather than treated as a reason to fail the release.
export function normalizeInternalSharingArtifact(artifact, log = () => {}) {
  if (!artifact || typeof artifact !== "object") throw new Error("Google Play returned no internal sharing artifact")
  const downloadUrl = typeof artifact.downloadUrl === "string" ? artifact.downloadUrl : ""
  if (!/^https:\/\//.test(downloadUrl)) {
    log(`Google Play internal sharing artifact fields: ${Object.keys(artifact).sort().join(",") || "none"}`)
    throw new Error("Google Play returned no HTTPS download URL for the internal sharing artifact")
  }
  const sha256 = typeof artifact.sha256 === "string" ? artifact.sha256.toLowerCase() : ""
  const certificateFingerprint =
    typeof artifact.certificateFingerprint === "string" ? artifact.certificateFingerprint : ""
  log(
    `Google Play internal sharing artifact: host=${new URL(downloadUrl).host} sha256=${
      /^[0-9a-f]{64}$/.test(sha256) ? "hex64" : `unexpected(${sha256.length} chars)`
    } certificateFingerprint=${certificateFingerprint ? `${certificateFingerprint.length} chars` : "absent"}`,
  )
  return {downloadUrl, sha256, certificateFingerprint}
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("Expected --name value pairs")
    values[args[index].slice(2)] = args[index + 1]
  }
  return values
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const artifact = await uploadInternalSharingBundle({
    credentials: JSON.parse(readFileSync(path.resolve(args.credentials), "utf8")),
    packageName: args.package,
    bundle: path.resolve(args.bundle),
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(artifact, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
