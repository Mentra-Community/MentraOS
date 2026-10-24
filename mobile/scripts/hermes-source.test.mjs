import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import test from "node:test"
import {fileURLToPath} from "node:url"

test("installed React Native keeps Hermes source aligned when binary probes fail", (t) => {
  const result = spawnSync("ruby", [fileURLToPath(new URL("./hermes-source.test.rb", import.meta.url))], {
    encoding: "utf8",
  })
  if (result.error?.code === "ENOENT") {
    t.skip("Ruby is unavailable; the iOS build requires Ruby and exercises the installed podspec")
    return
  }
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  assert.match(result.stdout, /8 Hermes source-selection checks passed/)
})
