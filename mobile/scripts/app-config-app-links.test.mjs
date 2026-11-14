import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import test from "node:test"

const mobile = fileURLToPath(new URL("..", import.meta.url))

function appConfig(track = "staging") {
  const output = execFileSync(
    process.execPath,
    [
      "--require",
      "tsx/cjs",
      "--eval",
      'const configure = require("./app.config.ts"); const c = configure({config: {}}); console.log(JSON.stringify({android: c.android.intentFilters, ios: c.ios.associatedDomains, scheme: c.scheme, package: c.android.package, name: c.name, displayName: c.ios.infoPlist.CFBundleDisplayName, plist: c.ios.infoPlist.CFBundleURLTypes}))',
    ],
    {
      cwd: mobile,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "ci-dummy-not-a-real-token",
        MENTRAOS_PINNED_BUILD_NUMBER: "303000123",
        MENTRA_APP_TRACK: track,
      },
    },
  )
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

test("the dev app has its own scheme and claims no app links, which the Mentra App holds", () => {
  const dev = appConfig("dev")
  assert.equal(dev.package, "com.mentra.mentra.dev")
  // The native project keeps the Mentra App's name, which CI and the build scripts open; people see Mentra Dev.
  assert.equal(dev.name, "Mentra")
  assert.equal(dev.displayName, "Mentra Dev")
  assert.equal(dev.scheme, "com.mentra.dev")
  assert.deepEqual(dev.plist[0].CFBundleURLSchemes, ["com.mentra.dev"])
  assert.deepEqual(dev.android, [])
  assert.deepEqual(dev.ios, [])
  assert.equal(appConfig().scheme, "com.mentra")
})
