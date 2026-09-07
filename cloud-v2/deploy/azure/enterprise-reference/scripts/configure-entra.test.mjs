import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

const source = readFileSync(new URL("configure-entra.sh", import.meta.url), "utf8")
const helper = source.match(/^find_or_create_app\(\) \{[\s\S]*?^\}/m)[0]
const exactApp = {id: "mobile-id", displayName: "Mentra Mobile"}
const productionApp = {id: "production-id", displayName: "Mentra Mobile Production"}

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
} else if (args.slice(0, 3).join(" ") === "ad app create") {
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
      `set -euo pipefail\n${helper}\nresult="$(find_or_create_app "$1" "$2")"\nprintf '%s' "$result"`,
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
    creates: calls.filter((call) => call[2] === "create"),
  }
}

test("a prefix-only registration is never reused", (t) => {
  const result = lookup(t, {apps: [productionApp]})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "created-id")
  assert.equal(result.creates.length, 1)
  assert.ok(!result.calls.flat().includes(productionApp.id))
})

test("one exact registration is reused from a single snapshot despite similar names", (t) => {
  const result = lookup(t, {apps: [productionApp, exactApp, {id: "uppercase-id", displayName: "MENTRA MOBILE"}]})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, exactApp.id)
  assert.equal(result.lists.length, 1)
  assert.equal(result.creates.length, 0)
})

test("duplicate exact names require an explicit client id", (t) => {
  const result = lookup(t, {apps: [exactApp, {...exactApp, id: "duplicate-id"}]})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /pass its client id explicitly/)
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
