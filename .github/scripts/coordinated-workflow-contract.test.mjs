import assert from "node:assert/strict"
import {existsSync, readFileSync} from "node:fs"
import test from "node:test"

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
}

function mobileScript(name) {
  return readFileSync(new URL(`../../mobile/scripts/${name}`, import.meta.url), "utf8")
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

test("production promotion is resumable and keeps irreversible actions behind separate environments", () => {
  const prepare = workflow("production-release-prepare.yml")
  const compatibilityLab = workflow("production-release-compatibility-lab.yml")
  const cloud = workflow("production-release-cloud.yml")
  const mobile = workflow("production-release-mobile.yml")
  const submit = workflow("production-release-store-submit.yml")
  const release = workflow("production-release-store-release.yml")
  const rollout = workflow("production-release-rollout.yml")
  const status = workflow("production-release-status.yml")

  for (const source of [prepare, compatibilityLab, cloud, mobile, submit, release, rollout, status]) {
    assert.match(source, /workflow_dispatch:/)
    assert.doesNotMatch(source, /pull_request:/)
    assert.match(source, /ref: main/)
  }
  assert.match(compatibilityLab, /name: production-compatibility-lab/)
  assert.match(compatibilityLab, /backend_environment: staging/)
  assert.match(compatibilityLab, /compatibility_lab: true/)
  assert.match(compatibilityLab, /play_track: internal-app-sharing/)
  assert.match(compatibilityLab, /Mentra Compatibility Lab/)
  assert.match(compatibilityLab, /current-production-release-manifest\.json/)
  assert.match(compatibilityLab, /--output promotion-input\/release-plan\.json/)
  assert.match(compatibilityLab, /path: promotion-input\/release-plan\.json/)
  assert.match(compatibilityLab, /--plan promotion-input\/plan\/release-plan\.json/)
  assert.doesNotMatch(compatibilityLab, /backend_environment: prod/)
  assert.doesNotMatch(compatibilityLab, /production-store-release/)
  assert.match(cloud, /name: production-cloud/)
  assert.doesNotMatch(cloud, /cloud-approved/)
  assert.match(cloud, /--record promotion-input\/current\.json \\\n+            --to cloud-deployed/)
  assert.match(mobile, /name: production-mobile-candidates/)
  assert.match(submit, /name: production-store-submission/)
  assert.match(release, /name: production-store-release/)
  assert.match(rollout, /name: production-store-release/)
  assert.match(status, /permissions:\n  contents: read/)
  assert.match(mobile, /backend_environment: prod/)
  assert.match(mobile, /play_track: internal/)
  assert.match(mobile, /Mentra Production Candidates/)
  assert.match(mobile, /Mentra SDK Example Production Candidates/)
  assert.match(mobile, /release_id: \$\{\{ needs\.load\.outputs\.promotion_release_id \}\}/)
  assert.match(mobile, /artifact_container_tag: \$\{\{ needs\.load\.outputs\.candidate_container_tag \}\}/)
  assert.doesNotMatch(mobile, /allocate stable artifact container/i)
  assert.match(submit, /GOOGLE_PLAY_RELEASE_STATUS=draft/)
  assert.doesNotMatch(submit, /automatic_release: true/)
  assert.doesNotMatch(release, /automatic_release: true/)
  assert.match(rollout, /\[\[ "\$percent" -gt "\$previous" \]\]/)
  assert.match(rollout, /\.evidence\[\]\.assetName/)
  assert.match(rollout, /to=finalizing/)
  assert.match(rollout, /finalize-production-promotion\.mjs/)
  assert.match(rollout, /\.artifactNames\.releasePlan/)
  assert.match(rollout, /\.artifactNames\.releaseManifest/)
  assert.match(rollout, /--to completed/)
  assert.doesNotMatch(rollout, /releases\/\$\{\{ steps\.promotion\.outputs\.release_id \}\}\/assets/)
  for (const source of [compatibilityLab, cloud, mobile, submit, release, rollout]) {
    assert.match(source, /production-promotion-assets\.mjs prepare-evidence/)
  }
  assert.match(submit, /validate-google-play-release\.mjs/)
  assert.match(submit, /--required-state draft/)
  assert.match(release, /validate-google-play-release\.mjs/)
  assert.match(release, /--required-state public/)
  assert.doesNotMatch(release, /\.tracks\.production \| map\(tonumber\)/)
  assert.equal(existsSync(new URL("../workflows/coordinated-production-promotion.yml", import.meta.url)), false)
  assert.equal(existsSync(new URL("../workflows/reusable-coordinated-mobile-promotion.yml", import.meta.url)), false)
})

test("Cloud V2 deploys once per coordinated environment before mobile publication", () => {
  const coordinator = workflow("coordinated-release.yml")
  const cloud = workflow("reusable-coordinated-cloud-v2.yml")
  const cloudJob = jobBlock(coordinator, "cloud-v2")
  const mobile = jobBlock(coordinator, "mobile")
  const finalize = jobBlock(coordinator, "finalize")
  const notify = jobBlock(coordinator, "notify-slack")

  assert.match(coordinator, /cloud_environment=dev/)
  assert.match(coordinator, /cloud_environment=staging/)
  assert.match(coordinator, /backend_environment=dev/)
  assert.match(coordinator, /backend_environment=staging/)
  assert.match(cloudJob, /^    needs: plan$/m)
  assert.match(cloudJob, /reusable-coordinated-cloud-v2\.yml/)
  assert.match(cloudJob, /deployment_environment: \$\{\{ needs\.plan\.outputs\.cloud_environment \}\}/)
  assert.match(mobile, /^    needs: \[plan, ota, cloud-v2\]$/m)
  assert.match(finalize, /needs\.cloud-v2\.result == 'success'/)
  assert.match(finalize, /--cloud release-input\/cloud-v2\/cloud-v2-deployment\.json/)
  assert.match(notify, /CLOUD_V2_RESULT: \$\{\{ needs\.cloud-v2\.result \}\}/)

  assert.match(cloud, /workflow_call:/)
  assert.match(cloud, /group: coordinated-cloud-v2-\$\{\{ inputs\.deployment_environment \}\}/)
  assert.match(cloud, /cancel-in-progress: false/)
  assert.match(cloud, /porter apply \\\n+            -w/)
  assert.match(cloud, /getent hosts "\$host"/)
  assert.match(cloud, /for probe in healthz ready/)
  assert.match(cloud, /porter kubectl -- get pods/)
  assert.match(cloud, /--status validated/)
  assert.match(cloud, /--status deployed/)
  assert.doesNotMatch(cloud, /--validate|--dry-run/)
  assert.doesNotMatch(cloud, /DNS is not configured.*skipping/i)

  for (const legacyOwner of ["cloud-v2-dev.yml", "cloud-v2-staging.yml", "cloud-v2-prod.yml"]) {
    assert.equal(existsSync(new URL(`../workflows/${legacyOwner}`, import.meta.url)), false)
  }
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
  assert.match(mobile, /MENTRA_TESTFLIGHT_INTERNAL_ONLY: \$\{\{ inputs\.compatibility_lab \}\}/)
  assert.match(mobile, /testFlightInternalTestingOnly -bool true/)
  assert.match(mobile, /google-play-internal-sharing\.mjs/)
  assert.match(mobile, /COMPATIBILITY-LAB-NOT-FOR-PRODUCTION/)
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
  assert.equal([...example.matchAll(/--app-id "\$EXAMPLE_APP_ID"/g)].length, 5)
  assert.match(example, /starterKit\.releaseCommit/)
  assert.match(example, /runs-on: \[self-hosted, macOS, ARM64\]/)
  assert.match(example, /app-store-connect-build\.mjs upload/)
  assert.match(mobile, /app-store-connect-build\.mjs upload/)
  assert.match(example, /app-store-connect-build\.mjs assign/)
  assert.match(example, /app-store-connect-build\.mjs testflight-preflight/)
  assert.match(example, /app-store-connect-build\.mjs wait/)
  assert.match(
    example,
    /INTERNAL_INSTALL_URL: https:\/\/appstoreconnect\.apple\.com\/apps\/6792839366\/testflight\/groups\/\{groupId\}/,
  )
  assert.doesNotMatch(example, /appstoreconnect\.apple\.com\/teams\//)
  assert.match(example, /Mentra Staging Public/)
  assert.match(example, /testflight_audience/)
  assert.match(example, /destination="\$GITHUB_WORKSPACE\/release-output\/mentra-example-react-native-/)
  assert.doesNotMatch(mobileIos, /app-store-connect-build\.mjs assign/)
  assert.match(mobileStore, /^    runs-on: ubuntu-latest$/m)
  assert.match(mobileStore, /app-store-connect-build\.mjs assign/)
  assert.doesNotMatch(exampleIos, /app-store-connect-build\.mjs assign/)
  assert.match(exampleStore, /^    runs-on: ubuntu-latest$/m)
  assert.match(exampleStore, /app-store-connect-build\.mjs assign/)
  assert.match(exampleStore, /--review-notes ""/)
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
  assert.match(docs, /^    needs: \[plan, starter-kit, example-testflight, finalize\]$/m)
  assert.match(docs, /needs\.starter-kit\.result == 'success'/)
  assert.match(docs, /needs\.finalize\.result == 'success'/)
  assert.match(docs, /needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(docs, /project=mentraos-docs-dev/)
  assert.match(docs, /docs_url=https:\/\/docs-dev\.mentraglass\.com/)
  assert.match(docs, /project=mentraos-docs-beta/)
  assert.match(docs, /docs_url=https:\/\/docs-beta\.mentraglass\.com/)
  assert.match(docs, /render-coordinated-docs\.mjs/)
  assert.match(docs, /--starter-kit/)
  assert.match(docs, /--example-testflight/)
  assert.match(docs, /X-Robots-Tag: noindex/)
  assert.match(docs, /grep --fixed-strings --quiet "\$RELEASE_IDENTITY" "\$body"/)
  assert.match(docs, /grep --fixed-strings --quiet "href=\\"\$EXAMPLE_APK_URL\\"" "\$body"/)
  assert.match(docs, /grep --fixed-strings --quiet "href=\\"\$EXAMPLE_IOS_URL\\"" "\$body"/)
  assert.match(docs, /%7b%7b\[a-z0-9_-\]\+%7d%7d/)
  assert.match(
    notify,
    /^    needs:\n      \[plan, cloud-v2, ota, npm, sdk-native, mobile, engine-consumer, starter-kit, example-testflight, finalize, docs\]$/m,
  )
  assert.match(notify, /STARTER_KIT_RESULT: \$\{\{ needs\.starter-kit\.result \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_RESULT: \$\{\{ needs\.example-testflight\.result \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_INSTALL_URL: \$\{\{ needs\.example-testflight\.outputs\.install_url \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_BUILD_NUMBER: \$\{\{ needs\.example-testflight\.outputs\.build_number \}\}/)
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

test("external example review replacements are manual and exact-build only", () => {
  const manual = workflow("submit-example-testflight-review.yml")

  assert.match(manual, /workflow_dispatch:/)
  assert.match(manual, /beta_identity:/)
  assert.match(manual, /review_notes:/)
  assert.match(manual, /mentra-release-\$BETA_IDENTITY\.json/)
  assert.match(manual, /\.starterKit\.testflight\.distribution\.status/)
  assert.match(manual, /--allow-rejected-override true/)
  assert.match(manual, /app-store-connect-build\.mjs testflight-preflight/)
  assert.match(manual, /app-store-connect-build\.mjs assign/)
  assert.doesNotMatch(manual, /app-store-connect-build\.mjs upload/)
  assert.doesNotMatch(manual, /xcodebuild|npm publish|porter apply/)
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
  assert.equal([...mobile.matchAll(/staging\) DOPPLER_TOKEN="\$DOPPLER_TOKEN_MOBILE_PRD"/g)].length, 2)
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
  assert.match(sdkNative, /react-native\/gradle\/libs\.versions\.toml/)
  assert.match(sdkNative, /sdkmanager "ndk;\$ndk_version"/)
  assert.doesNotMatch(sdkNative, /sdkmanager "ndk;[0-9]/)
})

test("Android release preserves the Expo-configured marketing version", () => {
  const androidPlugin = readFileSync(new URL("../../mobile/plugins/android.ts", import.meta.url), "utf8")
  const mobile = workflow("reusable-coordinated-mobile.yml")

  assert.doesNotMatch(androidPlugin, /replace\([^\n]*versionName/)
  assert.match(mobile, /version_name=\$\(sed -n "s\/\.\*versionName=/)
  assert.match(mobile, /Android versionName \$\{version_name:-<missing>\} does not match \$EXPECTED_VERSION/)
})

test("Android release keeps the GitHub APK arm64-only and the Play AAB multi-ABI", () => {
  const releaseAndroid = mobileScript("release-android.mjs")
  const mobileAndroid = jobBlock(workflow("reusable-coordinated-mobile.yml"), "android")

  assert.match(releaseAndroid, /const APK_ARCHITECTURES = 'arm64-v8a'/)
  assert.match(releaseAndroid, /const AAB_ARCHITECTURES = 'armeabi-v7a,arm64-v8a,x86,x86_64'/)
  assert.match(releaseAndroid, /gradlew assembleRelease -PreactNativeArchitectures=\$\{APK_ARCHITECTURES\}/)
  assert.equal(
    [...releaseAndroid.matchAll(/gradlew bundleRelease -PreactNativeArchitectures=\$\{AAB_ARCHITECTURES\}/g)].length,
    2,
  )
  assert.doesNotMatch(mobileAndroid, /ORG_GRADLE_PROJECT_reactNativeArchitectures:/)
  assert.match(mobileAndroid, /- name: Verify Android native version and production signature/)
  assert.match(mobileAndroid, /- name: Verify newly built Android ABI contract\n/)
  assert.match(
    mobileAndroid,
    /if: inputs\.dry_run == true \|\| needs\.prepare\.outputs\.android_assets_exist != 'true'/,
  )
  assert.match(mobileAndroid, /GitHub APK ABIs '\$\{apk_abis:-<none>\}' do not match required arm64-v8a/)
  assert.match(mobileAndroid, /Google Play AAB ABIs '\$\{aab_abis:-<none>\}' do not match required \$expected_aab_abis/)
})
