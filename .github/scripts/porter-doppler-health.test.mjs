import assert from "node:assert/strict"
import {test} from "node:test"
import {appProblems, environmentKeys, groupProblems, linkedGroups, syncProblems} from "./porter-doppler-health.mjs"

test("reports only names from multiline secret exports", () => {
  const text =
    'KEY=private\nPRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nprivate content\n-----END PRIVATE KEY-----\nJSON={\n "private": "value"\n}\n'
  assert.deepEqual(environmentKeys(text), ["KEY", "PRIVATE_KEY", "JSON"])
  const problems = appProblems({name: "app", groups: ["app-doppler"]}, "envGroups:\n    - app-doppler\n", text)
  assert.equal(problems[0], "app: Porter overrides KEY, PRIVATE_KEY, JSON")
  assert(!problems.join().includes("private content"))
})

test("detects missing, invalid and stale syncs", () => {
  const now = Date.parse("2026-10-07T20:00:00Z")
  const resources = [
    {
      kind: "SecretStore",
      metadata: {name: "app-doppler.1"},
      status: {conditions: [{type: "Ready", status: "False", reason: "InvalidProviderConfig"}]},
    },
    {
      kind: "ExternalSecret",
      metadata: {name: "app-doppler.1"},
      status: {conditions: [{type: "Ready", status: "True"}], refreshTime: "2026-10-07T19:00:00Z"},
    },
  ]
  assert.deepEqual(syncProblems(resources, ["app-doppler", "missing"], now), [
    "app-doppler: SecretStore InvalidProviderConfig",
    "app-doppler: stale or invalid refresh time",
    "missing: SecretStore missing",
    "missing: ExternalSecret missing",
  ])
})

test("accepts fresh healthy syncs and rejects invalid timestamps", () => {
  const now = Date.parse("2026-10-07T20:00:00Z")
  const resources = ["SecretStore", "ExternalSecret"].map((kind) => ({
    kind,
    metadata: {name: "app.1"},
    status: {conditions: [{type: "Ready", status: "True"}], refreshTime: "2026-10-07T19:59:50Z"},
  }))
  assert.deepEqual(syncProblems(resources, ["app"], now), [])
  resources[1].status.refreshTime = "invalid"
  assert.deepEqual(syncProblems(resources, ["app"], now), ["app: stale or invalid refresh time"])
})

test("detects manual groups without exposing YAML environment values", () => {
  const yaml =
    'env:\n    - key: SECRET\n      value: private\nenvGroups:\n    - "app-doppler"\n    - manual\nservices:\n    - name: web\n'
  assert.deepEqual(linkedGroups(yaml), ["app-doppler", "manual"])
  assert.deepEqual(appProblems({name: "app", groups: ["app-doppler"]}, yaml, ""), [
    "app: unexpected linked environment groups",
  ])
  assert.deepEqual(linkedGroups("envGroups: []\n"), [])
})

test("detects missing keys and wrong Doppler scope without reporting secret values", () => {
  const scope = {name: "app-doppler", project: "project", config: "prd", keys: ["PRIVATE_KEY", "API_KEY"]}
  const good = "DOPPLER_PROJECT=project\nDOPPLER_CONFIG=prd\nPRIVATE_KEY=secret-data\nAPI_KEY=secret-data\n"
  assert.deepEqual(groupProblems(scope, good), [])
  const problems = groupProblems(scope, good.replace("API_KEY=secret-data\n", "").replace("CONFIG=prd", "CONFIG=dev"))
  assert.equal(problems.length, 2)
  assert.ok(!problems.join().includes("secret-data"))
})
