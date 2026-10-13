// Core, the websites and the deployment recipes no longer use WorkOS. The only
// mentions left are the pieces that let people claim the memberships the Store
// imported from its WorkOS era: the membership field that names the waiting
// WorkOS user, the legacy identities, the claim, and the operator's export and
// import scripts. This guard keeps anything else from coming back.
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {existsSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const GUARDED = [
  "cloud-v2/packages",
  "cloud-v2/websites",
  "cloud-v2/docker",
  "cloud-v2/deploy",
  "cloud-v2/package.json",
  "cloud-v2/bun.lock",
  "bun.lock",
  "sdk/bun.lock",
]

/** Files that are the legacy membership claim, and may name WorkOS throughout. */
const LEGACY_CLAIM_FILES = [
  "cloud-v2/packages/core/src/models/legacy-browser-identity.model.ts",
  "cloud-v2/packages/core/src/services/workspaces/membership-claim.service.ts",
  "cloud-v2/packages/core/scripts/export-legacy-browser-identities.ts",
  "cloud-v2/packages/core/scripts/migrate-store-developer-orgs.ts",
]

/** `workspace_memberships.pendingWorkosUserId`: an imported membership's waiting WorkOS user. */
const PENDING_MEMBERSHIP_FIELD = /pendingWorkosUserId/

function workosMentions() {
  const result = spawnSync("git", ["grep", "-n", "-i", "-I", "-E", "workos|@workos-inc", "--", ...GUARDED], {
    cwd: root,
    encoding: "utf8",
  })
  // 1 means no match at all.
  if (result.status === 1) return []
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split("\n").filter(Boolean)
}

function allowed(line) {
  const file = line.slice(0, line.indexOf(":"))
  if (LEGACY_CLAIM_FILES.includes(file)) return true
  const text = line.slice(line.indexOf(":", file.length + 1) + 1)
  // Every mention on the line must be the membership field itself.
  return PENDING_MEMBERSHIP_FIELD.test(text) && !/workos/i.test(text.replaceAll(/pendingWorkosUserId/g, ""))
}

test("nothing outside the legacy membership claim names WorkOS", () => {
  const unexpected = workosMentions().filter(line => !allowed(line))
  assert.deepEqual(unexpected, [], `WorkOS is gone from MentraOS; remove these:\n${unexpected.join("\n")}`)
})

test("every allowed file still exists, so a removed one leaves the list", () => {
  for (const file of LEGACY_CLAIM_FILES) assert.ok(existsSync(path.join(root, file)), `${file} no longer exists`)
})

test("the field rule allows only the field", () => {
  const file = "cloud-v2/packages/core/src/services/workspaces/workspace.service.ts"
  assert.equal(allowed(`${file}:10:  pendingWorkosUserId: {type: String},`), true)
  assert.equal(allowed(`${file}:11:  const workos = new WorkOS(key)`), false)
  assert.equal(allowed(`${file}:12:  pendingWorkosUserId: workosUserId,`), false)
  assert.equal(allowed(`${LEGACY_CLAIM_FILES[0]}:3: * One document per WorkOS user`), true)
})
