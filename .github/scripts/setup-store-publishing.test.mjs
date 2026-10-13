import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"

import {
  CookieJar,
  isBranchPolicy,
  keyFindings,
  loadMiniapps,
  MENTRAOS,
  MINIAPPS,
  parseArguments,
  planSetup,
  publishBranch,
  REPOSITORIES,
  secretName,
  selectRepositories,
  staffEmail,
  STORES,
} from "./setup-store-publishing.mjs"

const workflow = readFileSync(new URL("../workflows/miniapp-store-publish.yml", import.meta.url), "utf8")

/** The workflow's Store table, with each Store's on/off expression read as off. */
function workflowStores() {
  const block = /STORES: >-\n((?: {12}.*\n)+)/.exec(workflow)?.[1]
  assert.ok(block, "the workflow lists its Stores in STORES")
  return JSON.parse(block.replace(/\$\{\{[^}]*\}\}/g, "false"))
}

test("publishes each Store from its own branch, with the environments and key names the script sets up", () => {
  const stores = workflowStores()
  assert.deepEqual(stores.map((store) => store.name).sort(), Object.keys(STORES).sort())
  const mentraos = REPOSITORIES.find((entry) => entry.repository === MENTRAOS)
  for (const store of stores) {
    const expected = STORES[store.name]
    assert.equal(store.url, expected.url, `${store.name} Store URL`)
    assert.equal(store.environment, expected.environment, `${store.name} environment`)
    assert.equal(store.secretPrefix, `${expected.secret}_`, `${store.name} key names`)
    assert.equal(store.branch, publishBranch(store.name, mentraos.branches), `${store.name} publishes from its branch`)
    assert.equal(store.on, !expected.switch, `${store.name} is on unless a variable switches it on`)
  }
  assert.ok(
    workflow.includes(`"on": \${{ vars.${STORES.staging.switch} == 'true' }}`),
    "the staging Store is on only once its repository variable is set",
  )
  assert.match(workflow, /^ {4}branches: \[dev, staging, main\]$/m, "every branch's pushes run the workflow")
  assert.match(workflow, /environment: \$\{\{ matrix\.store\.environment \}\}/)
  assert.match(workflow, /branch: \$\{\{ github\.ref_name \}\}/, "a run checks the tip of its own branch")
})

test("covers exactly the miniapps the workflow validates and publishes, with their key names", () => {
  const validated = /miniapp: \[([^\]]+)\]/
    .exec(workflow)?.[1]
    .split(",")
    .map((name) => name.trim())
  assert.deepEqual(
    validated,
    MINIAPPS.map((miniapp) => miniapp.directory),
  )
  for (const {directory, key} of MINIAPPS) {
    assert.ok(
      workflow.includes(`- {name: ${directory}, key: ${key}}`),
      `the workflow publishes ${directory} with ${key}`,
    )
  }
})

test("reads each MentraOS miniapp's package and Store listing", () => {
  const miniapps = loadMiniapps()
  assert.equal(miniapps.length, MINIAPPS.length)
  for (const miniapp of miniapps) {
    assert.match(miniapp.packageName, /^com\.mentra\.[a-z0-9.]+$/)
    assert.ok(miniapp.name)
  }
  assert.equal(miniapps.find((miniapp) => miniapp.packageName === "com.mentra.navigation")?.key, "MAPS")
})

test("publishes each Store from its own branch, or from main in a repository without that branch", () => {
  assert.equal(publishBranch("dev", ["dev", "staging", "main"]), "dev")
  assert.equal(publishBranch("staging", ["dev", "staging", "main"]), "staging")
  assert.equal(publishBranch("prod", ["dev", "staging", "main"]), "main")
  assert.equal(publishBranch("dev", ["dev", "main"]), "dev")
  assert.equal(publishBranch("staging", ["dev", "main"]), "main")
  assert.equal(publishBranch("dev", ["main"]), "main")
  assert.equal(publishBranch("staging", ["main"]), "main")
})

test("lists every first-party repository once, each with a main branch and com.mentra packages", () => {
  const names = REPOSITORIES.map((entry) => entry.repository)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.includes(MENTRAOS))
  const packages = REPOSITORIES.filter((entry) => entry.repository !== MENTRAOS).map((entry) => entry.packageName)
  assert.equal(new Set(packages).size, packages.length)
  for (const entry of REPOSITORIES) {
    assert.ok(entry.branches.includes("main"), `${entry.repository} has main`)
    if (entry.repository !== MENTRAOS) assert.match(entry.packageName, /^com\.mentra\.[a-z0-9.]+$/)
  }
  assert.deepEqual(
    selectRepositories(["mentra-call", "Mentra-Community/Merge-Miniapp"]).map((entry) => entry.repository),
    ["Mentra-Community/Mentra-Call", "Mentra-Community/Merge-Miniapp"],
  )
  assert.equal(selectRepositories([]), REPOSITORIES)
  assert.throws(() => selectRepositories(["Someone-Else"]), /not in REPOSITORIES/)
})

test("names a key after its Store, and after its miniapp in MentraOS", () => {
  assert.equal(secretName(STORES.dev, "CAPTIONS"), "MENTRA_DEV_STORE_PUBLISH_TOKEN_CAPTIONS")
  assert.equal(secretName(STORES.dev, ""), "MENTRA_DEV_STORE_PUBLISH_TOKEN")
  assert.equal(secretName(STORES.prod, ""), "MENTRA_STORE_PUBLISH_TOKEN", "production keeps its key names")
  assert.equal(secretName(STORES.prod, "MAPS"), "MENTRA_STORE_PUBLISH_TOKEN_MAPS")
})

test("reads the Store, repositories and options from the command line", () => {
  assert.deepEqual(parseArguments(["dev"]), {
    storeName: "dev",
    repos: [],
    dryRun: false,
    reissue: false,
    publish: false,
    environmentsOnly: false,
  })
  const options = parseArguments(["staging", "--repo", "Mentra-Call", "--repo=Merge-Miniapp", "--publish"])
  assert.deepEqual(options.repos, ["Mentra-Call", "Merge-Miniapp"])
  assert.equal(options.publish, true)
  assert.equal(parseArguments(["prod", "--environments-only"]).environmentsOnly, true)
  assert.throws(() => parseArguments([]), /name one Store/)
  assert.throws(() => parseArguments(["production"]), /name one Store/)
  assert.throws(() => parseArguments(["dev", "--repo"]), /needs a repository/)
  assert.throws(() => parseArguments(["dev", "--force"]), /unknown option/)
  assert.throws(() => parseArguments(["prod", "--environments-only", "--reissue"]), /issues no keys/)
})

test("reports a missing key, and any repository-level copy even when the environment has the key", () => {
  assert.deepEqual(
    keyFindings({
      keys: ["A", "B", "C", "D"],
      environment: "miniapp-store-production",
      inEnvironment: ["A", "B"],
      inRepository: ["B", "C"],
    }),
    [
      "B is also a repository secret, readable from every branch; delete that copy.",
      "C is a repository secret, readable from every branch; move it into miniapp-store-production.",
      "D is missing; Store staff issue it.",
    ],
  )
})

test("signs in as the QA account's +store-staff plus-address", () => {
  assert.equal(staffEmail("QA@Example.com"), "qa+store-staff@example.com")
  assert.equal(staffEmail("qa+other@example.com"), "qa+store-staff@example.com")
  assert.throws(() => staffEmail(undefined), /QA_TEST_EMAIL/)
})

test("creates only missing miniapps and issues only missing keys, unless reissuing", () => {
  const miniapps = [
    {packageName: "com.mentra.captions", key: "CAPTIONS"},
    {packageName: "com.mentra.recorder", key: "RECORDER"},
  ]
  const plan = planSetup({
    miniapps,
    storeApps: [{packageName: "com.mentra.captions"}],
    secretNames: ["MENTRA_DEV_STORE_PUBLISH_TOKEN_CAPTIONS", "MENTRA_STORE_PUBLISH_TOKEN_RECORDER"],
    store: STORES.dev,
  })
  assert.deepEqual(
    plan.map(({packageName, secret, create, issueKey}) => ({packageName, secret, create, issueKey})),
    [
      {
        packageName: "com.mentra.captions",
        secret: "MENTRA_DEV_STORE_PUBLISH_TOKEN_CAPTIONS",
        create: false,
        issueKey: false,
      },
      {
        packageName: "com.mentra.recorder",
        secret: "MENTRA_DEV_STORE_PUBLISH_TOKEN_RECORDER",
        create: true,
        issueKey: true,
      },
    ],
  )
  const reissue = planSetup({
    miniapps,
    storeApps: miniapps,
    secretNames: ["MENTRA_DEV_STORE_PUBLISH_TOKEN_CAPTIONS", "MENTRA_DEV_STORE_PUBLISH_TOKEN_RECORDER"],
    store: STORES.dev,
    reissue: true,
  })
  assert.deepEqual(
    reissue.map(({create, issueKey}) => ({create, issueKey})),
    [
      {create: false, issueKey: true},
      {create: false, issueKey: true},
    ],
  )
  const single = planSetup({
    miniapps: [{packageName: "com.mentra.call", key: ""}],
    storeApps: [],
    secretNames: [],
    store: STORES.staging,
  })
  assert.equal(single[0].secret, "MENTRA_STAGING_STORE_PUBLISH_TOKEN")
})

test("keeps one sign-in's cookies per host and drops expired ones", () => {
  const jar = new CookieJar()
  jar.store("https://account.example/oidc/auth", [
    "_interaction=abc; path=/interaction/1; httponly",
    "_session=s1; path=/; secure",
  ])
  assert.equal(jar.header("https://account.example/interaction/1/supabase"), "_interaction=abc; _session=s1")
  assert.equal(jar.header("https://elsewhere.example/"), null)
  jar.store("https://account.example/oidc/auth/1", ["_interaction=; Max-Age=0", "_session=s2; path=/"])
  assert.equal(jar.header("https://account.example/"), "_session=s2")
})

test("lets only the branch that publishes to a Store deploy to its environment", () => {
  assert.equal(isBranchPolicy({name: "dev", type: "branch"}, "dev"), true)
  assert.equal(isBranchPolicy({name: "main"}, "main"), true)
  assert.equal(isBranchPolicy({name: "dev", type: "tag"}, "dev"), false)
  assert.equal(isBranchPolicy({name: "dev", type: "branch"}, "main"), false)
  assert.equal(isBranchPolicy({name: "*", type: "branch"}, "main"), false)
})
