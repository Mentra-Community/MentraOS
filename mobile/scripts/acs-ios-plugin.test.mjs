import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const withAcsMeeting = require("../modules/acs-meeting/app.plugin.js")

async function applyPlugin(contents) {
  const config = withAcsMeeting({name: "Test", slug: "test"})
  const result = await config.mods.ios.podfile({
    ...config,
    modRequest: {platform: "ios", modName: "podfile"},
    modResults: {contents, language: "ruby"},
  })
  return result.modResults.contents
}

test("ACS plugin adds one repeatable pre-install hook to a default Expo Podfile", async () => {
  const original = "platform :ios, '15.1'\ntarget 'Test' do\n  use_expo_modules!\nend\n"
  const generated = await applyPlugin(original)
  assert.ok(generated.startsWith(original))
  assert.match(generated, /next unless pod.name == 'AzureCommunicationCommon'/)
  assert.match(generated, /Pod::BuildType.dynamic_framework/)
  assert.match(generated, /'BUILD_LIBRARY_FOR_DISTRIBUTION' => 'YES'/)
  assert.equal(await applyPlugin(generated), generated)
  assert.equal(generated.match(/pre_install do/g).length, 1)
})

test("ACS plugin preserves an existing host pre-install hook", async () => {
  const original = "pre_install do |installer|\n  configure_other_pods(installer)\nend\n"
  const generated = await applyPlugin(original)
  assert.equal(generated.match(/pre_install do/g).length, 1)
  assert.ok(generated.endsWith("  configure_other_pods(installer)\nend\n"))
  assert.equal(await applyPlugin(generated), generated)
})

test("the public ACS package and both shipped host configs include the plugin", () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8")
  const acs = JSON.parse(read("../modules/acs-meeting/package.json"))
  const oem = JSON.parse(read("../../sdk/example-oem-app/app.json"))
  assert.ok(acs.files.includes("app.plugin.js"))
  assert.ok(acs.dependencies["@expo/config-plugins"])
  assert.ok(oem.expo.plugins.includes("@mentra/acs-meeting"))
  assert.match(read("../app.config.ts"), /"@mentra\/acs-meeting"/)
})
