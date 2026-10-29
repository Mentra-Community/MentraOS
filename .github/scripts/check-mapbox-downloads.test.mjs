import assert from "node:assert/strict"
import test from "node:test"
import {checkMapboxDownloads, MAPBOX_PROBE_URL} from "./check-mapbox-downloads.mjs"

test("checks the authenticated SDK download before reporting success", async () => {
  await checkMapboxDownloads("test-download-credential", async (url, options) => {
    assert.equal(url, MAPBOX_PROBE_URL)
    assert.equal(new URL(url).hostname, "api.mapbox.com")
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from("mapbox:test-download-credential").toString("base64")}`)
    assert.ok(options.signal instanceof AbortSignal)
    return new Response("small POM", {status: 200})
  })
})

test("missing credentials fail without a download", async () => {
  for (const token of [undefined, "", "  "])
    await assert.rejects(checkMapboxDownloads(token, () => assert.fail("No request expected")), /MAPBOX_DOWNLOADS_TOKEN is missing/)
})

test("authentication, service and network failures are distinct and do not echo secrets", async () => {
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(checkMapboxDownloads("test-download-credential", async () => new Response("private provider body", {status})), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      if ([401, 403].includes(status)) assert.match(error.message, /authentication failed.*Downloads:Read/)
      else assert.doesNotMatch(error.message, /authentication failed/)
      assert.doesNotMatch(error.message, /test-download-credential|private provider body/)
      return true
    })
  }
  await assert.rejects(checkMapboxDownloads("test-download-credential", async () => { throw new Error("test-download-credential") }),
    error => error.message.includes("could not reach") && !error.message.includes("test-download-credential"))
})
