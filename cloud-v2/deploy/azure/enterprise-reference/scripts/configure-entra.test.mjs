import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

const source = readFileSync(new URL("configure-entra.sh", import.meta.url), "utf8")
const helper = source.match(/^find_or_create_app\(\) \{[\s\S]*?^\}/m)[0]
// Registrations this installer created carry its owner tag; only those are reused by name.
const owner = "mentraInstallerOwner:11111111-1111-1111-1111-111111111111"
const exactApp = {id: "mobile-id", displayName: "Mentra Mobile", tags: [owner]}
const productionApp = {id: "production-id", displayName: "Mentra Mobile Production", tags: [owner]}

// Model Azure CLI's prefix search and Graph's exact filter without contacting
// Azure. Every command, including any attempted write, is recorded locally.
const fakeAz = `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.ENTRA_TEST_CALLS, JSON.stringify(args) + "\\n")
const option = (name) => args[args.indexOf(name) + 1]
if (args.slice(0, 3).join(" ") === "ad app list") {
  if (process.env.ENTRA_TEST_LIST_OUTPUT) {
    process.stdout.write(process.env.ENTRA_TEST_LIST_OUTPUT)
    process.exit(Number(process.env.ENTRA_TEST_LIST_STATUS))
  }
  let apps = JSON.parse(process.env.ENTRA_TEST_APPS)
  if (args.includes("--display-name")) {
    apps = apps.filter(app => app.displayName.startsWith(option("--display-name")))
  } else {
    const match = option("--filter").match(/^displayName eq '((?:[^']|'')*)'$/)
    if (!match) process.exit(2)
    const name = match[1].replace(/''/g, "'")
    apps = apps.filter(app => app.displayName.toLowerCase() === name.toLowerCase())
  }
  if (args.includes("--query")) {
    console.log(option("--query") === "length(@)" ? apps.length : apps[0]?.id ?? "")
  } else console.log(JSON.stringify(apps))
} else if (args[0] === "rest" && option("--method") === "POST") {
  fs.writeFileSync(process.env.ENTRA_TEST_CALLS + ".body", option("--body"))
  console.log("created-id")
} else if (args.slice(0, 3).join(" ") === "ad app show") {
  console.log(option("--query") === "signInAudience" ? process.env.ENTRA_TEST_AUDIENCE : "explicit-id")
} else {
  console.error("Unexpected Azure command", args)
  process.exit(2)
}
`

function lookup(
  t,
  {apps = [], name = "Mentra Mobile", clientId = "", audience = "AzureADMyOrg", output = "", status = 0} = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "entra-lookup-"))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const callsFile = path.join(root, "calls.jsonl")
  writeFileSync(callsFile, "")
  writeFileSync(path.join(root, "az"), fakeAz, {mode: 0o755})
  // Match the real caller's command substitution, including macOS Bash 3.2's
  // disabled errexit inside it. A failed lookup must propagate to the caller.
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail\nOWNER_TAG='${owner}'\nretry() { "$@"; }\n${helper}\nresult="$(find_or_create_app "$1" "$2")"\nprintf '%s' "$result"`,
      "lookup",
      clientId,
      name,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        ENTRA_TEST_APPS: JSON.stringify(apps),
        ENTRA_TEST_CALLS: callsFile,
        ENTRA_TEST_AUDIENCE: audience,
        ENTRA_TEST_LIST_OUTPUT: output,
        ENTRA_TEST_LIST_STATUS: String(status),
      },
    },
  )
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  return {
    ...result,
    calls,
    lists: calls.filter((call) => call[2] === "list"),
    creates: calls.filter((call) => call[0] === "rest" && call.includes("POST")),
    body: () => JSON.parse(readFileSync(callsFile + ".body", "utf8")),
  }
}

test("a prefix-only registration is never reused; a new one is created single-tenant and tagged", (t) => {
  const result = lookup(t, {apps: [productionApp]})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "created-id")
  assert.equal(result.creates.length, 1)
  assert.ok(!result.calls.flat().includes(productionApp.id))
  assert.deepEqual(result.body(), {displayName: "Mentra Mobile", signInAudience: "AzureADMyOrg", tags: [owner]})
})

test("this installer's exact registration is reused from a single snapshot despite similar names", (t) => {
  const result = lookup(t, {apps: [productionApp, exactApp, {id: "uppercase-id", displayName: "MENTRA MOBILE"}]})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, exactApp.id)
  assert.equal(result.lists.length, 1)
  assert.equal(result.creates.length, 0)
})

test("a same-named registration this installer did not create is never adopted", (t) => {
  const result = lookup(t, {apps: [{...exactApp, tags: []}]})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /this setup did not create/)
  assert.equal(result.creates.length, 0)
  assert.equal(result.calls.length, 1)
})

test("duplicate registrations of this installer are reported", (t) => {
  const result = lookup(t, {apps: [exactApp, {...exactApp, id: "duplicate-id"}]})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /More than one app registration/)
  assert.equal(result.creates.length, 0)
  assert.equal(result.calls.length, 1)
})

for (const name of [
  "Customer's Mentra Mobile",
  "Mobile' or displayName eq 'Production",
  "Team \\ Mobile & $(literal)",
]) {
  test(`display names are passed literally: ${name}`, (t) => {
    const result = lookup(t, {apps: [{...exactApp, displayName: name}], name})
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, exactApp.id)
    assert.equal(result.creates.length, 0)
    assert.equal(result.lists[0][4], `displayName eq '${name.replaceAll("'", "''")}'`)
  })
}

test("explicit client ids bypass name discovery", (t) => {
  const result = lookup(t, {clientId: "chosen-client-id", apps: [exactApp, exactApp]})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "explicit-id")
  assert.equal(result.lists.length, 0)
  assert.equal(result.creates.length, 0)
  assert.ok(result.calls[0].includes("chosen-client-id"))
})

test("multi-tenant registrations are still rejected", (t) => {
  const result = lookup(t, {apps: [exactApp], audience: "AzureADMultipleOrgs"})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must be single-tenant/)
})

for (const [output, status] of [
  ["[]", 7],
  ["not json", 0],
  ["null", 0],
  ["{}", 0],
  [JSON.stringify([{displayName: exactApp.displayName, id: ""}]), 0],
]) {
  test(`failed or malformed lookup stops before using an app: ${output}, exit ${status}`, (t) => {
    const result = lookup(t, {output, status})
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.calls.length, 1)
    assert.equal(result.creates.length, 0)
  })
}

test("the private Azure CLI profile keeps a service principal's sign-in", (t) => {
  const copier = source.match(/<<'PYPROFILE'\n([\s\S]*?)\nPYPROFILE/)[1]
  const root = mkdtempSync(path.join(tmpdir(), "entra-profile-"))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const from = path.join(root, "from")
  const to = path.join(root, "to")
  spawnSync("mkdir", ["-p", from, to])
  for (const name of ["azureProfile.json", "service_principal_entries.json", "commands.log"]) {
    writeFileSync(path.join(from, name), name)
  }
  const result = spawnSync("python3", ["-", from, to], {input: copier, encoding: "utf8"})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(path.join(to, "service_principal_entries.json"), "utf8"), "service_principal_entries.json")
  assert.equal(readFileSync(path.join(to, "azureProfile.json"), "utf8"), "azureProfile.json")
  assert.throws(() => readFileSync(path.join(to, "commands.log")))
})

test("retries stay quiet until the last attempt", () => {
  const retry = source.match(/^retry\(\) \{[\s\S]*?^\}/m)[0]
  const run = (script) => spawnSync("/bin/bash", ["-c", `MENTRA_ENTRA_RETRY_SECONDS=0\n${retry}\n${script}`], {encoding: "utf8"})
  // Succeeds on the third try: the two expected failures print nothing.
  const recovered = run(`n=0\nflaky() { n=$((n + 1)); [[ $n -ge 3 ]] || { echo "does not exist" >&2; return 1; }; echo ok; }\nretry flaky`)
  assert.equal(recovered.status, 0)
  assert.equal(recovered.stdout.trim(), "ok")
  assert.equal(recovered.stderr, "")
  // Never succeeds: only the final attempt's error is shown.
  const failed = run(`broken() { echo "does not exist" >&2; return 1; }\nretry broken`)
  assert.notEqual(failed.status, 0)
  assert.equal(failed.stderr.trim(), "does not exist")
})

// Admin portal sign-in. A stand-in for the few Entra objects these paths touch:
// apps and service principals by ID, app owners and consent grants. Every
// write is recorded; nothing contacts Azure.
const GRAPH = "00000003-0000-0000-c000-000000000000"
const CORE = "33333333-3333-3333-3333-333333333333"
const MOBILE = "44444444-4444-4444-4444-444444444444"
const OPERATOR = "55555555-5555-5555-5555-555555555555"
const signInScopes = [
  {value: "openid", id: "id-openid"},
  {value: "email", id: "id-email"},
  {value: "profile", id: "id-profile"},
  {value: "offline_access", id: "id-offline"},
  {value: "User.Read", id: "id-user-read"},
]
const fakeEntra = `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
const world = JSON.parse(fs.readFileSync(process.env.ENTRA_WORLD, "utf8"))
fs.appendFileSync(process.env.ENTRA_TEST_CALLS, JSON.stringify(args) + "\\n")
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
function reply(value) {
  const query = option("--query")
  if (query === "[0].id") value = value[0]?.id ?? ""
  else if (query === "value[].id") value = value.value.map((item) => item.id)
  else if (query === "value[0].id") value = value.value[0]?.id ?? ""
  else if (query) value = value[query]
  if (option("-o") === "tsv" || option("--output") === "tsv") console.log(value ?? "")
  else console.log(JSON.stringify(value))
}
const command = args.slice(0, 3).join(" ")
if (args.slice(0, 2).join(" ") === "account show") reply({tenantId: world.tenantId})
else if (command === "ad app show") {
  const app = world.apps.find((a) => a.id === option("--id") || a.appId === option("--id"))
  if (!app) process.exit(3)
  reply(app)
} else if (command === "ad sp list") {
  const appId = option("--filter").match(/appId eq '([^']+)'/)[1]
  reply(world.sps.filter((s) => s.appId === appId))
} else if (command === "ad sp show") {
  const sp = world.sps.find((s) => s.appId === option("--id") || s.id === option("--id"))
  if (!sp) process.exit(3)
  reply(sp)
} else if (args[0] === "rest") {
  const uri = option("--uri")
  if (option("--method") === "GET" && uri.includes("/owners")) reply({value: (world.owners || []).map((id) => ({id}))})
  else if (option("--method") === "GET" && uri.includes("oauth2PermissionGrants")) reply({value: []})
  else if (option("--method") === "GET" && uri.includes("/servicePrincipals/")) reply({tags: []})
  else if (option("--method") === "PATCH" || option("--method") === "POST") {
    fs.appendFileSync(process.env.ENTRA_TEST_CALLS + ".writes", JSON.stringify({method: option("--method"), uri, body: JSON.parse(option("--body"))}) + "\\n")
  } else process.exit(9)
} else {
  console.error("Unexpected Azure command", args)
  process.exit(9)
}
`

function coreApp(overrides = {}) {
  return {
    id: "core-object",
    appId: CORE,
    signInAudience: "AzureADMyOrg",
    web: {homePageUrl: "https://intranet.acme.example", redirectUris: ["https://other.acme.example/callback"],
      redirectUriSettings: [{uri: "https://other.acme.example/callback", index: null}], implicitGrantSettings: {enableIdTokenIssuance: false}},
    optionalClaims: {idToken: [{name: "upn", source: null, essential: false, additionalProperties: []}], accessToken: [{name: "ipaddr"}]},
    requiredResourceAccess: [
      {resourceAppId: "66666666-6666-6666-6666-666666666666", resourceAccess: [{id: "kept", type: "Scope"}]},
      {resourceAppId: GRAPH, resourceAccess: [{id: "id-user-read", type: "Scope"}]},
    ],
    ...overrides,
  }
}

function entra(t, cliArgs, {apps = [coreApp()], scopes = signInScopes, owners = [], env = {}, graph = {}} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "entra-portal-"))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const callsFile = path.join(root, "calls.jsonl")
  writeFileSync(callsFile, "")
  writeFileSync(path.join(root, "az"), fakeEntra, {mode: 0o755})
  const sps = [
    {id: "graph-sp", appId: GRAPH, oauth2PermissionScopes: scopes, ...graph},
    {id: "acs-sp", appId: "1fd5118e-2576-4263-8130-9503064c837a",
      oauth2PermissionScopes: [{value: "Teams.ManageCalls", id: "id-calls"}, {value: "Teams.ManageChats", id: "id-chats"}]},
    {id: "core-sp", appId: CORE},
    {id: "mobile-sp", appId: MOBILE},
    {id: "other-sp", appId: "66666666-6666-6666-6666-666666666666", oauth2PermissionScopes: [{value: "Other.Read", id: "kept"}]},
  ]
  writeFileSync(path.join(root, "world.json"), JSON.stringify({tenantId: "tenant", apps, sps, owners}))
  const result = spawnSync("/bin/bash", [new URL("configure-entra.sh", import.meta.url).pathname, ...cliArgs], {
    encoding: "utf8",
    env: {...process.env, PATH: `${root}:${process.env.PATH}`, ENTRA_WORLD: path.join(root, "world.json"),
      ENTRA_TEST_CALLS: callsFile, MENTRA_ENTRA_RETRY_SECONDS: "0", MENTRA_SUBSCRIPTION_ID: "", ...env},
  })
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [])
  return {...result, calls: read(callsFile), writes: read(callsFile + ".writes")}
}

test("admin portal sign-in adds Core's redirect, email claim and sign-in scopes and keeps the rest", (t) => {
  const result = entra(t, ["--admin-portal-only", "--core-client-id", CORE, "--admin-portal-url", "https://core.acme.example/"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    tenantId: "tenant",
    coreApiClientId: CORE,
    adminPortalRedirectUri: "https://core.acme.example/interaction/callback/workforce",
  })
  // One change, to the Core registration only: no Mobile, service principal or consent writes.
  assert.equal(result.writes.length, 1)
  const {method, uri, body} = result.writes[0]
  assert.equal(method, "PATCH")
  assert.equal(uri, "https://graph.microsoft.com/v1.0/applications/core-object")
  assert.deepEqual(body.web.redirectUris.sort(), [
    "https://core.acme.example/interaction/callback/workforce",
    "https://other.acme.example/callback",
  ])
  assert.equal(body.web.homePageUrl, "https://intranet.acme.example")
  assert.equal("redirectUriSettings" in body.web, false)
  assert.deepEqual(body.optionalClaims.idToken.map((claim) => claim.name), ["upn", "email"])
  assert.deepEqual(body.optionalClaims.accessToken, [{name: "ipaddr"}])
  const graph = body.requiredResourceAccess.find((access) => access.resourceAppId === GRAPH)
  // Only the OpenID sign-in scopes are added; a scope an administrator added stays.
  assert.deepEqual(graph.resourceAccess.map((access) => access.id).sort(), ["id-email", "id-openid", "id-profile", "id-user-read"])
  assert.ok(graph.resourceAccess.every((access) => access.type === "Scope"))
  assert.deepEqual(body.requiredResourceAccess.find((access) => access.resourceAppId !== GRAPH).resourceAccess, [{id: "kept", type: "Scope"}])
})

test("admin portal sign-in is idempotent", (t) => {
  const configured = coreApp({
    web: {redirectUris: ["https://core.acme.example/interaction/callback/workforce"]},
    optionalClaims: {idToken: [{name: "email", source: null, essential: true, additionalProperties: ["include_externally_authenticated_upn"]}]},
    requiredResourceAccess: [{resourceAppId: GRAPH, resourceAccess: ["id-openid", "id-email", "id-profile"].map((id) => ({id, type: "Scope"}))}],
  })
  const result = entra(t, ["--admin-portal-only", "--core-client-id", CORE, "--admin-portal-url", "https://core.acme.example"], {apps: [configured]})
  assert.equal(result.status, 0, result.stderr)
  const {body} = result.writes[0]
  assert.deepEqual(body.web.redirectUris, ["https://core.acme.example/interaction/callback/workforce"])
  // An administrator's own email claim settings are kept, not duplicated.
  assert.deepEqual(body.optionalClaims.idToken, configured.optionalClaims.idToken)
  assert.equal(body.requiredResourceAccess.length, 1)
  assert.equal(body.requiredResourceAccess[0].resourceAccess.length, 3)
})

test("without Core's address the redirect is left alone", (t) => {
  const result = entra(t, ["--admin-portal-only", "--core-client-id", CORE])
  assert.equal(result.status, 0, result.stderr)
  assert.equal("web" in result.writes[0].body, false)
  assert.equal("adminPortalRedirectUri" in JSON.parse(result.stdout), false)
})

test("missing Microsoft Graph sign-in scopes stop before any change", (t) => {
  const result = entra(t, ["--admin-portal-only", "--core-client-id", CORE], {scopes: signInScopes.filter((s) => s.value !== "email")})
  assert.notEqual(result.status, 0)
  assert.equal(result.writes.length, 0)
})

test("a Microsoft Graph service principal larger than the command-line limit still configures sign-in", (t) => {
  // Linux rejects a single argv over 128KiB. macOS ARG_MAX here is 1MiB.
  // The real Graph service principal exceeds both once it is passed to jq --argjson.
  const bulky = "x".repeat(1_500_000)
  const result = entra(
    t,
    ["--admin-portal-only", "--core-client-id", CORE, "--admin-portal-url", "https://core.acme.example"],
    {apps: [coreApp({keyCredentials: [{key: bulky}]})], graph: {padding: bulky}},
  )
  assert.equal(result.status, 0, result.stderr)
  const {body} = result.writes[0]
  assert.equal("keyCredentials" in body, false)
  assert.ok(body.web.redirectUris.includes("https://core.acme.example/interaction/callback/workforce"))
  assert.ok(!JSON.stringify(body).includes(bulky))
})

test("the operator is made an owner of Core once", (t) => {
  for (const [owners, added] of [[[], 1], [[OPERATOR], 0]]) {
    const result = entra(t, ["--admin-portal-only", "--core-client-id", CORE, "--core-owner", OPERATOR], {owners})
    assert.equal(result.status, 0, result.stderr)
    const posts = result.writes.filter((write) => write.uri.endsWith("/owners/$ref"))
    assert.equal(posts.length, added)
    if (added) {
      assert.equal(posts[0].uri, "https://graph.microsoft.com/v1.0/applications/core-object/owners/$ref")
      assert.deepEqual(posts[0].body, {"@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${OPERATOR}`})
    }
  }
})

test("consent-only grants Core's sign-in scopes along with Mobile's", (t) => {
  const mobile = {id: "mobile-object", appId: MOBILE, requiredResourceAccess: [{resourceAppId: GRAPH, resourceAccess: [{id: "id-user-read", type: "Scope"}]}]}
  const core = coreApp({requiredResourceAccess: [{resourceAppId: GRAPH, resourceAccess: ["id-openid", "id-email", "id-profile"].map((id) => ({id, type: "Scope"}))}]})
  const result = entra(t, ["--consent-only", "--mobile-client-id", MOBILE, "--core-client-id", CORE], {apps: [core, mobile]})
  assert.equal(result.status, 0, result.stderr)
  const grants = result.writes.filter((write) => write.uri.endsWith("/oauth2PermissionGrants")).map((write) => write.body)
  assert.deepEqual(grants, [
    {clientId: "mobile-sp", consentType: "AllPrincipals", resourceId: "graph-sp", scope: "User.Read"},
    {clientId: "core-sp", consentType: "AllPrincipals", resourceId: "graph-sp", scope: "openid email profile"},
  ])
  assert.equal(JSON.parse(result.stdout).coreApiClientId, CORE)
})

for (const [cliArgs, message] of [
  [["--admin-portal-only"], /requires --core-client-id/],
  [["--admin-portal-only", "--core-client-id", CORE, "--admin-portal-url", "http://core.acme.example"], /https:\/\/ origin/],
  [["--admin-portal-only", "--core-client-id", CORE, "--admin-portal-url", "https://core.acme.example/portal"], /https:\/\/ origin/],
  [["--admin-portal-only", "--core-client-id", CORE, "--admin-portal-url", "https://Core.acme.example"], /https:\/\/ origin/],
  [["--admin-portal-only", "--core-client-id", CORE, "--core-owner", "operator@acme.example"], /--core-owner must be an object ID/],
]) {
  test(`invalid admin portal options are refused before Azure is called: ${cliArgs.slice(-1)[0]}`, (t) => {
    const result = entra(t, cliArgs)
    assert.equal(result.status, 2)
    assert.match(result.stderr, message)
    assert.equal(result.calls.length, 0)
  })
}

test("reconciling both apps also sets up Core's admin portal sign-in and consent", (t) => {
  const mobile = {id: "mobile-object", appId: MOBILE, signInAudience: "AzureADMyOrg"}
  const result = entra(t, ["--core-client-id", CORE, "--mobile-client-id", MOBILE, "--admin-portal-url", "https://core.acme.example",
    "--core-owner", OPERATOR, "--grant-admin-consent"], {apps: [coreApp(), mobile]})
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.adminPortalRedirectUri, "https://core.acme.example/interaction/callback/workforce")
  assert.equal(output.mobileClientId, MOBILE)
  const corePatches = result.writes.filter((write) => write.uri.endsWith("/applications/core-object"))
  // The existing Core reconcile, then admin portal sign-in.
  assert.equal(corePatches.length, 2)
  assert.ok(corePatches[0].body.api.oauth2PermissionScopes.some((scope) => scope.value === "mentra.session"))
  assert.ok(corePatches[1].body.web.redirectUris.includes(output.adminPortalRedirectUri))
  assert.ok(result.writes.some((write) => write.uri.endsWith("/applications/core-object/owners/$ref")))
  assert.ok(result.writes.some((write) => write.uri.endsWith("/applications/mobile-object")))
  // Consent covers Core too. (The stand-in does not apply PATCHes, so the scopes
  // granted are the app's earlier ones; the consent-only test checks the sign-in scopes.)
  const grants = result.writes.filter((write) => write.uri.endsWith("/oauth2PermissionGrants")).map((write) => write.body.clientId)
  assert.ok(grants.includes("core-sp"))
})
