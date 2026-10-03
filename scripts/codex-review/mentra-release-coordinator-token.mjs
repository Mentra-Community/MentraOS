#!/usr/bin/env node
// Mint a short-lived GitHub App installation token for the
// mentra-release-coordinator app (the same app the coordinated release
// pipeline uses), scoped to one repository, and print ONLY the token.
//
// Used by the codex-pr-review skill so reviews are posted
// by the app rather than by the PR author's own account, which GitHub refuses to
// let approve its own pull requests.
//
//   GH_TOKEN=$(node scripts/codex-review/mentra-release-coordinator-token.mjs MentraOS)
//
// Key file: $MENTRA_RELEASE_COORDINATOR_KEY, defaulting to the 0600 copy under
// ~/.config/mentra-release-coordinator/. Tokens expire after one hour.
import {readFileSync} from "node:fs"
import {createSign} from "node:crypto"

const APP_ID = "4745360"
const OWNER = "Mentra-Community"
const repository = process.argv[2] || "MentraOS"
const keyPath =
  process.env.MENTRA_RELEASE_COORDINATOR_KEY ||
  `${process.env.HOME}/.config/mentra-release-coordinator/private-key.pem`

const pem = readFileSync(keyPath)
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const now = Math.floor(Date.now() / 1000)
const unsigned = `${b64({alg: "RS256", typ: "JWT"})}.${b64({iat: now - 60, exp: now + 540, iss: APP_ID})}`
const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(pem).toString("base64url")}`
const headers = {Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json"}

const installations = await (await fetch("https://api.github.com/app/installations", {headers})).json()
const installation = Array.isArray(installations) && installations.find((entry) => entry.account?.login === OWNER)
if (!installation) {
  console.error(`mentra-release-coordinator is not installed on ${OWNER}: ${JSON.stringify(installations)}`)
  process.exit(1)
}
const response = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    repositories: [repository],
    permissions: {metadata: "read", contents: "read", pull_requests: "write", checks: "read"},
  }),
})
const token = await response.json()
if (!response.ok || !token.token) {
  console.error(`Token request failed with HTTP ${response.status}: ${token.message || ""}`)
  process.exit(1)
}
process.stdout.write(token.token)
