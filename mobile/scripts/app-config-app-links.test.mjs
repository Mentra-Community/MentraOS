import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import test from "node:test"

const mobile = fileURLToPath(new URL("..", import.meta.url))

function appConfig() {
  const output = execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval",
    'const configure = require("./app.config.ts"); const c = configure({config: {}}); console.log(JSON.stringify({android: c.android.intentFilters, ios: c.ios.associatedDomains}))',
  ], {
    cwd: mobile,
    encoding: "utf8",
    env: {...process.env, EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "ci-dummy-not-a-real-token", MENTRAOS_PINNED_BUILD_NUMBER: "303000123"},
  })
  return JSON.parse(output)
}

test("Android claims only the open link and the package link on the directory's hosts, verified", () => {
  const {android} = appConfig()
  const links = android.filter((filter) => filter.data?.some((data) => data.scheme === "https"))
  assert.equal(links.length, 1)
  assert.equal(links[0].autoVerify, true)
  assert.deepEqual(links[0].category, ["DEFAULT", "BROWSABLE"])
  assert.deepEqual(links[0].data, [
    {scheme: "https", host: "apps.mentra.glass", path: "/open"},
    {scheme: "https", host: "apps.mentra.glass", pathPrefix: "/package/"},
    {scheme: "https", host: "apps.mentraglass.com", path: "/open"},
    {scheme: "https", host: "apps.mentraglass.com", pathPrefix: "/package/"},
  ])
})

test("iOS associates the same hosts; the website's association file chooses the paths", () => {
  assert.deepEqual(appConfig().ios, ["applinks:apps.mentra.glass", "applinks:apps.mentraglass.com"])
})
