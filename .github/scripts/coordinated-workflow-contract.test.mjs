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
  const sdkNativeWorkflow = workflow("reusable-coordinated-sdk-native.yml")
  const sdkNative = jobBlock(sdkNativeWorkflow, "prepare")

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
  assert.match(sdkNativeWorkflow, /for attempt in \{1\.\.6\}/)
  assert.match(
    sdkNativeWorkflow,
    /cmp --silent native-result\/maven\/sonatype-deployment\.json persisted-deployment\.json/,
  )
})

test("mobile destinations use real TestFlight groups without changing the release channel", () => {
  const coordinator = workflow("coordinated-release.yml")
  const mobile = workflow("reusable-coordinated-mobile.yml")
  const example = workflow("reusable-coordinated-example-testflight.yml")
  const mobileIos = jobBlock(mobile, "ios")
  const mobileStore = jobBlock(mobile, "ios-store")
  const exampleIos = jobBlock(example, "ios")
  const exampleStore = jobBlock(example, "testflight")

  assert.match(coordinator, /testflight_group=Mentra Dev/)
  assert.match(coordinator, /testflight_group=Mentra Staging/)
  assert.match(mobile, /MENTRA_COORDINATED_RELEASE_CHANNEL=\$\(jq -er \.channel release-intent\/release-plan\.json\)/)
  assert.doesNotMatch(mobile, /MENTRA_COORDINATED_RELEASE_CHANNEL=\$\{\{ inputs\.testflight_group \}\}/)
  assert.match(example, /EXAMPLE_APP_ID: "6792839366"/)
  assert.match(example, /EXAMPLE_BUNDLE_ID: com\.mentra\.bluetoothsdkexample/)
  assert.match(example, /config\.expo\.ios\.bundleIdentifier = process\.env\.EXAMPLE_BUNDLE_ID/)
  assert.match(example, /find ios -maxdepth 1 -name '\*\.xcworkspace'/)
  assert.match(example, /select\(\. == "MentraSDKRN"\)/)
  assert.match(example, /security list-keychains -d user -s "\$keychain"/)
  assert.match(example, /certificate_id=\$\(basename "\$certificate" \.cer\)/)
  assert.match(example, /awk -v fingerprint="\$certificate_fingerprint" '\$2 == fingerprint/)
  assert.match(example, /bundle exec fastlane sigh/)
  assert.match(example, /--app_identifier "\$EXAMPLE_BUNDLE_ID"/)
  assert.match(example, /--cert_id "\$certificate_id"/)
  assert.match(example, /CODE_SIGN_STYLE=Manual/)
  assert.match(example, /CODE_SIGN_IDENTITY="\$MENTRA_CI_CODE_SIGN_IDENTITY"/)
  assert.match(example, /PROVISIONING_PROFILE_SPECIFIER="\$MENTRA_CI_PROVISIONING_PROFILE_NAME"/)
  assert.match(example, /OTHER_CODE_SIGN_FLAGS="--keychain \$MENTRA_CI_KEYCHAIN"/)
  assert.match(example, /provisioningProfiles: \{\(\$bundle_id\): \$profile\}/)
  assert.match(example, /PlistBuddy -c 'Print :com\.apple\.developer\.networking\.HotspotConfiguration'/)
  assert.equal([...example.matchAll(/--app-id "\$EXAMPLE_APP_ID"/g)].length, 3)
  assert.match(example, /starterKit\.releaseCommit/)
  assert.match(example, /runs-on: \[self-hosted, macOS, ARM64\]/)
  assert.match(example, /app-store-connect-build\.mjs upload/)
  assert.match(mobile, /app-store-connect-build\.mjs upload/)
  assert.match(example, /app-store-connect-build\.mjs assign/)
  assert.match(example, /destination="\$GITHUB_WORKSPACE\/release-output\/mentra-example-react-native-/)
  assert.doesNotMatch(mobileIos, /app-store-connect-build\.mjs assign/)
  assert.match(mobileStore, /^    runs-on: ubuntu-latest$/m)
  assert.match(mobileStore, /app-store-connect-build\.mjs assign/)
  assert.doesNotMatch(exampleIos, /app-store-connect-build\.mjs assign/)
  assert.match(exampleStore, /^    runs-on: ubuntu-latest$/m)
  assert.match(exampleStore, /app-store-connect-build\.mjs assign/)
})

test("coordinated docs publish only after finalization to the matching channel", () => {
  const coordinator = workflow("coordinated-release.yml")
  const starterKit = jobBlock(coordinator, "starter-kit")
  const engineConsumer = jobBlock(coordinator, "engine-consumer")
  const exampleTestflight = jobBlock(coordinator, "example-testflight")
  const docs = jobBlock(coordinator, "docs")
  const notify = jobBlock(coordinator, "notify-slack")

  assert.match(starterKit, /^    needs: \[plan, ota\]$/m)
  assert.match(engineConsumer, /^    needs: \[plan, npm\]$/m)
  assert.match(starterKit, /coordinated-example-release\.yml/)
  assert.match(starterKit, /event_type: "coordinated_example_release"/)
  assert.match(starterKit, /--event repository_dispatch/)
  assert.doesNotMatch(starterKit, /gh workflow run coordinated-example-release\.yml/)
  assert.match(starterKit, /starter-kit-release-\$identity\.json/)
  assert.match(starterKit, /select\(\.displayTitle == [^\n]+ and \.status != \\"completed\\"\)/)
  assert.match(starterKit, /encoded_candidate_branch=\$\(jq -rn[^\n]+'\$value \| @uri'\)/)
  assert.match(starterKit, /--json status,conclusion 2>\/dev\/null \|\| true/)
  assert.doesNotMatch(starterKit, /repos\/\$STARTER_KIT_REPOSITORY\/pulls/)
  assert.doesNotMatch(starterKit, /gh pr create/)
  assert.doesNotMatch(starterKit, /gh pr checks/)
  assert.doesNotMatch(starterKit, /gh pr merge/)
  assert.match(starterKit, /Create Starter Kit request token/)
  assert.match(starterKit, /Wait for the immutable Starter Kit result/)
  assert.match(starterKit, /Create Starter Kit verification token/)
  assert.match(starterKit, /--location "\$result_url" --output \/dev\/null/)
  assert.doesNotMatch(starterKit, /--location --head "\$result_url"/)
  assert.match(starterKit, /for _ in \{1\.\.630\}/)
  assert.match(starterKit, /gh pr view "\$pull_request_url"[^]*--json url,state,headRefOid,baseRefName,mergeCommit/)
  assert.match(starterKit, /git\/ref\/tags\/sdk-\$identity/)
  assert.match(starterKit, /\.digest <<< "\$asset"/)
  assert.match(starterKit, /actions\/create-github-app-token@v3/)
  assert.match(starterKit, /app-id: \$\{\{ vars\.STARTER_KIT_COORDINATOR_APP_ID \}\}/)
  assert.match(starterKit, /private-key: \$\{\{ secrets\.STARTER_KIT_COORDINATOR_APP_PRIVATE_KEY \}\}/)
  assert.match(starterKit, /continue-on-error: true/)
  assert.doesNotMatch(starterKit, /STARTER_KIT_APP_PRIVATE_KEY:/)
  assert.match(starterKit, /permission-actions: read/)
  assert.match(starterKit, /permission-contents: write/)
  assert.doesNotMatch(starterKit, /permission-pull-requests: write/)
  assert.match(starterKit, /permission-contents: read/)
  assert.match(starterKit, /permission-pull-requests: read/)
  assert.match(starterKit, /\[\[ "\$branch_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/)
  assert.doesNotMatch(starterKit, /candidate_sha=\$\([^\n]+\n\s+--jq \.commit\.sha 2>\/dev\/null \|\| true\)/)
  assert.doesNotMatch(starterKit, /lookup_starter_pr|repos\/\$STARTER_KIT_REPOSITORY\/pulls/)
  assert.match(
    starterKit,
    /STARTER_KIT_TOKEN: \$\{\{ steps\.starter-kit-request-token\.outputs\.token \|\| secrets\.STARTER_KIT_COORDINATOR_TOKEN/,
  )
  assert.match(
    starterKit,
    /STARTER_KIT_TOKEN: \$\{\{ steps\.starter-kit-verification-token\.outputs\.token \|\| secrets\.STARTER_KIT_COORDINATOR_TOKEN/,
  )
  assert.match(exampleTestflight, /^    needs: \[plan, starter-kit\]$/m)
  assert.match(exampleTestflight, /reusable-coordinated-example-testflight\.yml/)
  assert.match(jobBlock(coordinator, "finalize"), /needs\.starter-kit\.result == 'success'/)
  assert.match(jobBlock(coordinator, "finalize"), /needs\.example-testflight\.result == 'success'/)
  assert.match(jobBlock(coordinator, "finalize"), /needs\.engine-consumer\.result == 'success'/)
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
    /^    needs: \[plan, ota, npm, sdk-native, mobile, engine-consumer, starter-kit, example-testflight, finalize, docs\]$/m,
  )
  assert.match(notify, /STARTER_KIT_RESULT: \$\{\{ needs\.starter-kit\.result \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_RESULT: \$\{\{ needs\.example-testflight\.result \}\}/)
  assert.match(notify, /STARTER_KIT_RUN_URL: \$\{\{ needs\.starter-kit\.outputs\.run_url \}\}/)
  assert.match(notify, /DOCS_RESULT: \$\{\{ needs\.docs\.result \}\}/)
  const example = workflow("reusable-coordinated-example-testflight.yml")
  assert.match(example, /actions\/create-github-app-token@v3/)
  assert.match(example, /private-key: \$\{\{ secrets\.STARTER_KIT_COORDINATOR_APP_PRIVATE_KEY \}\}/)
  assert.match(example, /continue-on-error: true/)
  assert.doesNotMatch(example, /STARTER_KIT_APP_PRIVATE_KEY:/)
  assert.match(example, /permission-contents: read/)
  assert.match(example, /^      group: mentra-ios-signing-runner$/m)
  assert.match(
    example,
    /token: \$\{\{ steps\.starter-kit-app-token\.outputs\.token \|\| secrets\.STARTER_KIT_COORDINATOR_TOKEN/,
  )
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
