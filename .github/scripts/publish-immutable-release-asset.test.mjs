import assert from "node:assert/strict"
import test from "node:test"

import {matchingAsset, releaseAssetUploadUrl, uploadReleaseAsset} from "./publish-immutable-release-asset.mjs"

test("selects one immutable release asset and rejects duplicates", () => {
  assert.equal(matchingAsset([{name: "one"}, {name: "two"}], "two").name, "two")
  assert.equal(matchingAsset([{name: "one"}], "missing"), null)
  assert.throws(() => matchingAsset([{name: "one"}, {name: "one"}], "one"), /duplicate/)
})

test("targets GitHub's release upload host without enterprise API routing", () => {
  assert.equal(
    releaseAssetUploadUrl("Mentra-Community/MentraOS", "123", "Mentra 3.1.0 #1.apk"),
    "https://uploads.github.com/repos/Mentra-Community/MentraOS/releases/123/assets?name=Mentra%203.1.0%20%231.apk",
  )
})

test("uploads asset bytes with an exact Content-Length", async () => {
  const body = Buffer.from("mentra-live-asg")
  const requests = []
  await uploadReleaseAsset({
    repository: "Mentra-Community/MentraOS",
    releaseId: "123",
    name: "asg.apk",
    body,
    token: "release-token",
    fetchImpl: async (url, options) => {
      requests.push({url, ...options})
      return {ok: true}
    },
  })

  assert.equal(requests.length, 1)
  const [request] = requests
  assert.equal(request.method, "POST")
  assert.equal(request.url, releaseAssetUploadUrl("Mentra-Community/MentraOS", "123", "asg.apk"))
  assert.equal(request.headers["content-length"], String(body.byteLength))
  assert.equal(request.headers["content-type"], "application/octet-stream")
  assert.equal(request.headers.authorization, "Bearer release-token")
  assert.equal(request.body, body)
})

test("surfaces the upload host's HTML rejection instead of a bare exit code", async () => {
  await assert.rejects(
    uploadReleaseAsset({
      repository: "Mentra-Community/MentraOS",
      releaseId: "123",
      name: "asg.apk",
      body: Buffer.from("bytes"),
      token: "release-token",
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => "<html>\n  <h1>Whoa there!</h1>\n</html>",
      }),
    }),
    /Uploading asg\.apk failed with HTTP 400: <html> <h1>Whoa there!<\/h1> <\/html>/,
  )
})

test("refuses to upload without a token", async () => {
  await assert.rejects(
    uploadReleaseAsset({repository: "o/r", releaseId: "1", name: "a.apk", body: Buffer.alloc(0)}),
    /GH_TOKEN is required/,
  )
})
