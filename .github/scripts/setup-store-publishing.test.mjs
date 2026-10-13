import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"

import {
  CookieJar,
  isDevBranchPolicy,
  loadMiniapps,
  MINIAPPS,
  planSetup,
  staffEmail,
  STORES,
} from "./setup-store-publishing.mjs"

const workflow = readFileSync(new URL("../workflows/miniapp-store-publish.yml", import.meta.url), "utf8")

test("sets up the same Stores, environments and key names the publish workflow uses", () => {
  assert.match(
    workflow,
    /^ {10}- \{name: prod, url: "https:\/\/api\.apps\.mentraglass\.com", environment: "", secretPrefix: MENTRA_STORE_PUBLISH_TOKEN_\}$/m,
  )
  for (const [name, store] of Object.entries(STORES)) {
    const entry = `{name: ${name}, url: "${store.url}", environment: ${store.environment}, secretPrefix: ${store.secretPrefix}}`
    assert.ok(workflow.includes(entry), `the workflow lists the ${name} Store as ${entry}`)
    assert.notEqual(store.secretPrefix, "MENTRA_STORE_PUBLISH_TOKEN_", "only production uses the repository secrets")
  }
  assert.match(workflow, /^ {10}- \{name: dev, /m, "the dev Store publishes")
  assert.match(workflow, /^ {10}# - \{name: staging, /m, "the staging Store stays off until its keys exist")
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

test("reads each miniapp's package and Store listing", () => {
  const miniapps = loadMiniapps()
  assert.equal(miniapps.length, MINIAPPS.length)
  for (const miniapp of miniapps) {
    assert.match(miniapp.packageName, /^com\.mentra\.[a-z0-9.]+$/)
    assert.ok(miniapp.name)
  }
  assert.equal(miniapps.find((miniapp) => miniapp.directory === "navigation")?.key, "MAPS")
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
    secretPrefix: "MENTRA_DEV_STORE_PUBLISH_TOKEN_",
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
    secretPrefix: "MENTRA_DEV_STORE_PUBLISH_TOKEN_",
    reissue: true,
  })
  assert.deepEqual(
    reissue.map(({create, issueKey}) => ({create, issueKey})),
    [
      {create: false, issueKey: true},
      {create: false, issueKey: true},
    ],
  )
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

test("lets only the dev branch deploy to a Store's environment", () => {
  assert.equal(isDevBranchPolicy({name: "dev", type: "branch"}), true)
  assert.equal(isDevBranchPolicy({name: "dev"}), true)
  assert.equal(isDevBranchPolicy({name: "dev", type: "tag"}), false)
  assert.equal(isDevBranchPolicy({name: "main", type: "branch"}), false)
  assert.equal(isDevBranchPolicy({name: "*", type: "branch"}), false)
})
