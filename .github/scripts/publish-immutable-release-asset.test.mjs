import assert from "node:assert/strict"
import test from "node:test"

import {findReleaseAsset, matchingAsset, releaseAssetUploadUrl} from "./publish-immutable-release-asset.mjs"

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

test("filters all release asset pages inside gh and safely quotes the exact name", () => {
  const name = 'Mentra "quoted" \\ build.apk'
  const asset = {id: 123, name}
  const result = findReleaseAsset("owner/repo", "456", name, (args, options) => {
    assert.deepEqual(args, [
      "api",
      "--paginate",
      "repos/owner/repo/releases/456/assets?per_page=100",
      "--jq",
      `.[] | select(.name == ${JSON.stringify(name)}) | {id, name} | tojson`,
    ])
    assert.equal(options.encoding, "utf8")
    return JSON.stringify(asset)
  })
  assert.deepEqual(result, asset)
})

test("filtered lookups retain missing-asset and duplicate-asset behavior", () => {
  assert.equal(findReleaseAsset("owner/repo", "1", "missing", () => ""), null)
  assert.throws(
    () => findReleaseAsset("owner/repo", "1", "one", () => '{"id":1,"name":"one"}\n{"id":2,"name":"one"}\n'),
    /duplicate asset one/,
  )
  assert.throws(() => findReleaseAsset("owner/repo", "1", "one", () => "invalid JSON"), SyntaxError)
})
