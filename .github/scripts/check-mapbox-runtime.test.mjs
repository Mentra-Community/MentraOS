import assert from "node:assert/strict"
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import test from "node:test"

import {checkMapboxRuntime} from "./check-mapbox-runtime.mjs"

const token = "private-runtime-credential"

test("checks search and geocoding with runtime credentials and bounded requests", async () => {
  const urls = []
  let cancelled = 0
  await checkMapboxRuntime(token, async (url, options) => {
    urls.push(url)
    assert.equal(url.hostname, "api.mapbox.com")
    assert.equal(url.searchParams.get("access_token"), token)
    assert.equal(options.redirect, "error")
    assert.ok(options.signal instanceof AbortSignal)
    return {ok: true, status: 200, body: {cancel: async () => {cancelled++}}}
  })
  assert.equal(cancelled, 2)
  assert.equal(urls[0].pathname, "/search/searchbox/v1/suggest")
  assert.match(urls[0].searchParams.get("session_token"), /^[a-f0-9-]{36}$/)
  assert.equal(urls[0].searchParams.get("types"), "poi,address,place,street")
  assert.equal(urls[1].pathname, "/search/geocode/v6/reverse")
})

test("missing tokens fail before contacting the provider", async () => {
  for (const missing of [undefined, "", " "]) {
    await assert.rejects(checkMapboxRuntime(missing, () => assert.fail("Unexpected fetch")), /MAPBOX_ACCESS_TOKEN is missing/)
  }
})

test("rejects provider errors without exposing URLs, tokens or response bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    for (const failedProbe of [1, 2]) {
      let calls = 0
      await assert.rejects(checkMapboxRuntime(token, async () => {
        calls++
        return new Response(token, {status: calls === failedProbe ? status : 200})
      }), error => {
        assert.match(error.message, new RegExp(`HTTP ${status}`))
        assert.equal(error.message.includes(token), false)
        assert.equal(error.message.includes("access_token="), false)
        return true
      })
      assert.equal(calls, failedProbe)
    }
  }
})

test("redacts transport failures containing authenticated URLs", async () => {
  await assert.rejects(checkMapboxRuntime(token, async url => {throw new Error(url.href)}), error => {
    assert.match(error.message, /could not reach/)
    assert.equal(error.message.includes(token), false)
    return true
  })
})

test("promotion checks both environments before recording config readiness", () => {
  const workflow = readFileSync(new URL("../workflows/production-release-cloud.yml", import.meta.url), "utf8")
  for (const environment of ["staging", "prod"]) {
    assert.match(workflow, new RegExp(`--environment ${environment} \\\\\n\\s+--env-file [^\\n]+\\n\\s+--check-maps true`))
  }
})

test("CLI writes authentication evidence only after successful provider probes", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "maps-preflight-"))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  mkdirSync(path.join(directory, "cloud-v2/packages"), {recursive: true})
  const contract = path.join(directory, "contract.json")
  const envFile = path.join(directory, "config.env")
  const hook = path.join(directory, "fetch.mjs")
  const output = path.join(directory, "evidence.json")
  writeFileSync(contract, JSON.stringify({schemaVersion: 1, contractVersion: "test", required: {
    MAPS_PROVIDER: {kind: "enum", values: ["mapbox"], acceptanceTest: "maps-provider"},
    MAPBOX_ACCESS_TOKEN: {kind: "secret", acceptanceTest: "maps-provider"},
  }}))
  writeFileSync(envFile, `MAPS_PROVIDER=mapbox\nMAPBOX_ACCESS_TOKEN=${token}\n`)
  for (const status of [401, 200]) {
    writeFileSync(hook, `globalThis.fetch = async () => new Response('private provider body', {status: ${status}})`)
    const result = spawnSync(process.execPath, ["--import", hook, ".github/scripts/validate-production-cloud-config.mjs",
      "--contract", contract, "--root", directory, "--environment", "prod", "--env-file", envFile,
      "--check-maps", "true", "--output", output], {encoding: "utf8"})
    assert.equal(result.status, status === 200 ? 0 : 1, result.stderr)
    assert.equal(result.stderr.includes(token), false)
    if (status === 401) assert.equal(existsSync(output), false)
    else {
      const evidence = readFileSync(output, "utf8")
      assert.equal(evidence.includes(token), false)
      assert.equal(JSON.parse(evidence).checks.find(c => c.id === "maps-provider-authentication").status, "pass")
    }
  }
})
