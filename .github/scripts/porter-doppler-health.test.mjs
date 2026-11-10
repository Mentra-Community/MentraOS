import assert from "node:assert/strict"
import {test} from "node:test"
import {
  checkHealth,
  appProblems,
  environmentKeys,
  groupProblems,
  isolationProblems,
  linkedGroups,
} from "./porter-doppler-health.mjs"

test("reports only names from multiline secret exports", () => {
  const text =
    'KEY=private\nPRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nprivate content\n-----END PRIVATE KEY-----\nJSON={\n "private": "value"\n}\n'
  assert.deepEqual(environmentKeys(text), ["KEY", "PRIVATE_KEY", "JSON"])
  const problems = appProblems({name: "app", groups: ["app-doppler"]}, "envGroups:\n    - app-doppler\n", text)
  assert.equal(problems[0], "app: Porter overrides KEY, PRIVATE_KEY, JSON")
  assert(!problems.join().includes("private content"))
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

test("checks contracted groups even when no managed app consumes them", async () => {
  const contract = {
    project: 15081,
    clusters: [{id: 5690, target: "east"}],
    apps: [],
    groups: [{name: "prepared-doppler", cluster: 5690, project: "project", config: "legacy", keys: ["API_KEY"]}],
  }
  const calls = []
  const run = async (args) => {
    calls.push(args.slice(0, 3))
    return "DOPPLER_PROJECT=project\nDOPPLER_CONFIG=legacy\n"
  }
  assert.deepEqual(await checkHealth(contract, {run}), ["prepared-doppler: missing Doppler keys API_KEY"])
  // Only reads the Porter project token is allowed to make; no kubectl.
  assert.deepEqual(calls, [["env", "pull", "--group"]])
})

test("flags environments that share a database without reporting it", () => {
  const rules = [{name: "app database", keys: ["MONGODB_URI", "MONGODB_DB"], groups: ["dev", "stg", "prd", "absent"]}]
  const uri = "MONGODB_URI=mongodb+srv://user:secret-data@cluster/\n"
  const exported = new Map([
    ["dev", `${uri}MONGODB_DB=app-dev\n`],
    ["stg", `${uri}MONGODB_DB=app-dev\n`],
    ["prd", `${uri}MONGODB_DB=app\n`],
  ])
  const problems = isolationProblems(rules, exported)
  assert.deepEqual(problems, ["app database: dev and stg share MONGODB_URI + MONGODB_DB"])
  assert.ok(!problems.join().includes("secret-data"))
  exported.set("stg", `${uri}MONGODB_DB=app-staging\n`)
  assert.deepEqual(isolationProblems(rules, exported), [])
})

test("a group without the resource does not share it", () => {
  const rules = [{name: "tape", keys: ["BUCKET"], groups: ["dev", "prd"]}]
  assert.deepEqual(isolationProblems(rules, new Map([["dev", "BUCKET=tape\n"], ["prd", "OTHER=1\n"]])), [])
  assert.deepEqual(isolationProblems(undefined, new Map()), [])
})
