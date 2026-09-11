import assert from "node:assert/strict"
import {mkdtempSync, rmSync, writeFileSync} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {verifyPublicReleaseAsset} from "./verify-public-release-asset.mjs"

function fixture(context, contents = "immutable release bytes") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mentra-release-asset-"))
  context.after(() => rmSync(directory, {force: true, recursive: true}))
  const file = path.join(directory, "asset.json")
  writeFileSync(file, contents)
  return file
}

test("waits for the public release asset to serve the immutable bytes", async (context) => {
  const file = fixture(context)
  const responses = [
    {ok: false, status: 404},
    {ok: true, status: 200, arrayBuffer: async () => Buffer.from("immutable release bytes")},
  ]
  const delays = []

  await verifyPublicReleaseAsset({
    file,
    url: "https://github.com/Mentra-Community/MentraOS/releases/download/test/asset.json",
    attempts: 2,
    delayMs: 7,
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (delay) => delays.push(delay),
  })

  assert.deepEqual(delays, [7])
})

test("fails after bounded attempts when the public bytes never match", async (context) => {
  const file = fixture(context)
  let requests = 0

  await assert.rejects(
    verifyPublicReleaseAsset({
      file,
      url: "https://github.com/Mentra-Community/MentraOS/releases/download/test/asset.json",
      attempts: 2,
      delayMs: 0,
      fetchImpl: async () => {
        requests += 1
        return {ok: true, status: 200, arrayBuffer: async () => Buffer.from("stale bytes")}
      },
      sleepImpl: async () => {},
    }),
    /public bytes differ.*after 2 attempts|after 2 attempts.*public bytes differ/,
  )
  assert.equal(requests, 2)
})
