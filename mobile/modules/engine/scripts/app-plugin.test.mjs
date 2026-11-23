import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const withMentraEngine = require("../app.plugin.js")

const FILTER = {
  action: "VIEW",
  autoVerify: true,
  data: [
    {scheme: "https", host: "apps.mentra.glass", path: "/open"},
    {scheme: "https", host: "apps.mentra.glass", pathPrefix: "/package/"},
    {scheme: "https", host: "apps.mentraglass.com", path: "/open"},
    {scheme: "https", host: "apps.mentraglass.com", pathPrefix: "/package/"},
  ],
  category: ["DEFAULT", "BROWSABLE"],
}
const DOMAINS = ["applinks:apps.mentra.glass", "applinks:apps.mentraglass.com"]

test("claims only the open link and the package link on the link hosts, verified", () => {
  const config = withMentraEngine({name: "Host", slug: "host"})
  assert.deepEqual(config.android.intentFilters, [FILTER])
  assert.deepEqual(config.ios.associatedDomains, DOMAINS)
})

test("keeps what the host app already declares", () => {
  const own = {action: "VIEW", data: [{scheme: "https", host: "host.example.com"}], category: ["DEFAULT", "BROWSABLE"]}
  const config = withMentraEngine({
    name: "Host",
    slug: "host",
    scheme: "host",
    ios: {bundleIdentifier: "com.example.host", associatedDomains: ["applinks:host.example.com"]},
    android: {package: "com.example.host", intentFilters: [own]},
  })
  assert.deepEqual(config.android.intentFilters, [own, FILTER])
  assert.deepEqual(config.ios.associatedDomains, ["applinks:host.example.com", ...DOMAINS])
  assert.equal(config.scheme, "host")
  assert.equal(config.ios.bundleIdentifier, "com.example.host")
  assert.equal(config.android.package, "com.example.host")
})

test("applied twice, it claims the links once", () => {
  const config = withMentraEngine(withMentraEngine({name: "Host", slug: "host"}))
  assert.deepEqual(config.android.intentFilters, [FILTER])
  assert.deepEqual(config.ios.associatedDomains, DOMAINS)
})

test("miniappLinks: false claims nothing", () => {
  const input = {name: "Host", slug: "host"}
  assert.equal(withMentraEngine(input, {miniappLinks: false}), input)
})

test("does not change the config it is given", () => {
  const input = {name: "Host", slug: "host", ios: {associatedDomains: []}, android: {intentFilters: []}}
  withMentraEngine(input)
  assert.deepEqual(input, {name: "Host", slug: "host", ios: {associatedDomains: []}, android: {intentFilters: []}})
})

test("claims the hosts the engine reads links on", () => {
  const source = readFileSync(new URL("../src/miniapp-links/index.ts", import.meta.url), "utf8")
  const declared = /MINIAPP_LINK_HOSTS: readonly string\[\] = (\[[^\]]*\])/.exec(source)?.[1]
  assert.ok(declared, "src/miniapp-links/index.ts declares MINIAPP_LINK_HOSTS")
  assert.deepEqual([...withMentraEngine.MINIAPP_LINK_HOSTS].sort(), JSON.parse(declared).sort())
})
