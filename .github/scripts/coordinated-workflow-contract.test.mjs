import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
}

function jobBlock(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `Missing workflow job ${name}`)
  const rest = source.slice(start + 1)
  const next = rest.slice(1).search(/^  [a-z0-9-]+:\n/m)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

test("coordinated OTA assets have bounded release ownership", () => {
  const coordinator = workflow("coordinated-release.yml")
  const ota = workflow("reusable-coordinated-ota.yml")

  assert.match(coordinator, /release_id: \$\{\{ needs\.plan\.outputs\.release_id \}\}/)
  assert.match(ota, /ASG_RELEASE_TAG: mentra-coordinated-asg/)
  assert.match(ota, /asg_release_base=.*\$\{ASG_RELEASE_TAG\}/)
  assert.match(ota, /release_base=.*\$\{release_tag\}/)
  assert.match(ota, /for file in coordinated-ota-work\/asg-release-assets\/\*/)
  assert.match(ota, /for file in coordinated-ota-work\/release-assets\/\*/)
  assert.match(ota, /--release-id "\$\{\{ inputs\.release_id \}\}"/)
  assert.match(ota, /artifactContainerTag/)
  assert.doesNotMatch(ota, /draft: false, prerelease: true, body:/)
  assert.doesNotMatch(ota, /OTA_RELEASE_TAG/)
})

test("release finalization reads the preserved OTA artifact layout", () => {
  const finalize = jobBlock(workflow("coordinated-release.yml"), "finalize")

  assert.match(
    finalize,
    /asg_selection="release-input\/ota\/release-assets\/\$\(jq -er \.artifactNames\.asgSelection "\$plan"\)"/,
  )
})

test("production validates before approval and proves packages before mobile promotion", () => {
  const production = workflow("coordinated-production-promotion.yml")
  const sdkNative = jobBlock(workflow("reusable-coordinated-sdk-native.yml"), "prepare")

  assert.doesNotMatch(jobBlock(production, "plan"), /^    needs:/m)
  assert.match(jobBlock(production, "approve"), /^    needs: plan$/m)
  assert.match(jobBlock(production, "approve"), /environment:\n      name: coordinated-production-release/)
  assert.match(jobBlock(production, "npm"), /^    needs: \[plan, approve\]$/m)
  assert.match(jobBlock(production, "sdk-native"), /^    needs: \[plan, approve\]$/m)
  assert.match(jobBlock(production, "engine-consumer"), /^    needs: \[plan, npm, sdk-native\]$/m)
  assert.match(jobBlock(production, "mobile"), /^    needs: \[plan, engine-consumer\]$/m)
  assert.match(
    jobBlock(production, "finalize"),
    /^    needs: \[plan, approve, npm, sdk-native, mobile, engine-consumer\]$/m,
  )
  assert.match(sdkNative, /channel=\$\(jq -er \.channel release-intent\/release-plan\.json\)/)
  assert.match(
    sdkNative,
    /if \[\[ "\$channel" == "production" \]\]; then\s+\[\[ "\$\(jq -r \.draft <<< "\$release"\)" == "true" \]\]\s+\[\[ "\$\(jq -r \.prerelease <<< "\$release"\)" == "false" \]\]/,
  )
  assert.match(
    sdkNative,
    /else\s+\[\[ "\$\(jq -r \.draft <<< "\$release"\)" == "false" \]\]\s+\[\[ "\$\(jq -r \.prerelease <<< "\$release"\)" == "true" \]\]/,
  )
})

test("mobile destinations use real TestFlight groups without changing the release channel", () => {
  const coordinator = workflow("coordinated-release.yml")
  const mobile = workflow("reusable-coordinated-mobile.yml")

  assert.match(coordinator, /testflight_group=Mentra Dev/)
  assert.match(coordinator, /testflight_group=Mentra Staging/)
  assert.match(mobile, /MENTRA_COORDINATED_RELEASE_CHANNEL=\$\(jq -er \.channel release-intent\/release-plan\.json\)/)
  assert.doesNotMatch(mobile, /MENTRA_COORDINATED_RELEASE_CHANNEL=\$\{\{ inputs\.testflight_group \}\}/)
})

test("coordinated docs publish only after finalization to the matching channel", () => {
  const coordinator = workflow("coordinated-release.yml")
  const starterKit = jobBlock(coordinator, "starter-kit")
  const docs = jobBlock(coordinator, "docs")
  const notify = jobBlock(coordinator, "notify-slack")

  assert.match(starterKit, /^    needs: \[plan, ota, npm, sdk-native, engine-consumer\]$/m)
  assert.match(starterKit, /coordinated-example-release\.yml/)
  assert.match(starterKit, /starter-kit-release-\$identity\.json/)
  assert.match(starterKit, /\.digest <<< "\$asset"/)
  assert.match(jobBlock(coordinator, "finalize"), /needs\.starter-kit\.result == 'success'/)
  assert.match(docs, /^    needs: \[plan, starter-kit, finalize\]$/m)
  assert.match(docs, /needs\.starter-kit\.result == 'success'/)
  assert.match(docs, /needs\.finalize\.result == 'success'/)
  assert.match(docs, /needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(docs, /project=mentraos-docs-dev/)
  assert.match(docs, /docs_url=https:\/\/docs-dev\.mentraglass\.com/)
  assert.match(docs, /project=mentraos-docs-beta/)
  assert.match(docs, /docs_url=https:\/\/docs-beta\.mentraglass\.com/)
  assert.match(docs, /render-coordinated-docs\.mjs/)
  assert.match(docs, /--starter-kit/)
  assert.match(docs, /X-Robots-Tag: noindex/)
  assert.match(docs, /grep --fixed-strings --quiet "\$RELEASE_IDENTITY" "\$body"/)
  assert.match(
    notify,
    /^    needs: \[plan, ota, npm, sdk-native, mobile, engine-consumer, starter-kit, finalize, docs\]$/m,
  )
  assert.match(notify, /STARTER_KIT_RESULT: \$\{\{ needs\.starter-kit\.result \}\}/)
  assert.match(notify, /DOCS_RESULT: \$\{\{ needs\.docs\.result \}\}/)
})

test("mobile release selects an existing Doppler token for its backend", () => {
  const mobile = workflow("reusable-coordinated-mobile.yml")

  assert.match(mobile, /DOPPLER_TOKEN_MOBILE_DEV:/)
  assert.match(mobile, /DOPPLER_TOKEN_MOBILE_PRD:/)
  assert.equal(
    [...mobile.matchAll(/DOPPLER_TOKEN_MOBILE_DEV: \$\{\{ secrets\.DOPPLER_TOKEN_MOBILE_DEV \}\}/g)].length,
    2,
  )
  assert.equal(
    [...mobile.matchAll(/DOPPLER_TOKEN_MOBILE_PRD: \$\{\{ secrets\.DOPPLER_TOKEN_MOBILE_PRD \}\}/g)].length,
    2,
  )
  assert.equal([...mobile.matchAll(/case "\$BACKEND_ENVIRONMENT" in/g)].length, 2)
  assert.equal([...mobile.matchAll(/dev\) DOPPLER_TOKEN="\$DOPPLER_TOKEN_MOBILE_DEV"/g)].length, 2)
  assert.equal([...mobile.matchAll(/prod\) DOPPLER_TOKEN="\$DOPPLER_TOKEN_MOBILE_PRD"/g)].length, 2)
  assert.doesNotMatch(mobile, /DOPPLER_TOKEN_MOBILE_PRD \|\|/)
})

test("Maven generation builds every local config plugin before Expo prebuild", () => {
  const sdkNative = jobBlock(workflow("reusable-coordinated-sdk-native.yml"), "maven")
  const crustPluginBuild = sdkNative.search(/working-directory: mobile\/modules\/crust\n\s+run: bun run build:plugin/)
  const bluetoothPluginBuild = sdkNative.search(
    /working-directory: mobile\/modules\/bluetooth-sdk\n\s+run: bun run build:plugin/,
  )
  const prebuild = sdkNative.indexOf("bun expo prebuild --platform android")

  assert.notEqual(crustPluginBuild, -1)
  assert.notEqual(bluetoothPluginBuild, -1)
  assert.notEqual(prebuild, -1)
  assert.ok(crustPluginBuild < prebuild)
  assert.ok(bluetoothPluginBuild < prebuild)
})

test("Android release preserves the Expo-configured marketing version", () => {
  const androidPlugin = readFileSync(new URL("../../mobile/plugins/android.ts", import.meta.url), "utf8")
  const mobile = workflow("reusable-coordinated-mobile.yml")

  assert.doesNotMatch(androidPlugin, /replace\([^\n]*versionName/)
  assert.match(mobile, /version_name=\$\(sed -n "s\/\.\*versionName=/)
  assert.match(mobile, /Android versionName \$\{version_name:-<missing>\} does not match \$EXPECTED_VERSION/)
})
