import assert from "node:assert/strict"
import {existsSync, readFileSync, mkdtempSync, readdirSync, rmSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
}

function mobileScript(name) {
  return readFileSync(new URL(`../../mobile/scripts/${name}`, import.meta.url), "utf8")
}

function mobileFastfile(name) {
  return readFileSync(new URL(`../../mobile/ci/${name}/Fastfile`, import.meta.url), "utf8")
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
  assert.match(prepare, /group: production-release-prepare\n/)
  assert.doesNotMatch(prepare, /group: production-release-prepare-\$\{\{/)
  assert.match(prepare, /--beta "\$\{\{ inputs\.beta_identity \}\}"/)
  assert.match(prepare, /production-promotion-assets\.mjs selection-digest/)
  assert.match(prepare, /--selection-digest "\$\{\{ steps\.selection\.outputs\.selection_digest \}\}"/)
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
  assert.match(cloud, /ref: \$\{\{ steps\.source\.outputs\.commit \}\}/)
  assert.match(cloud, /--root promotion-source/)
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
  for (const source of [prepare, mobile, submit, release, status]) {
    assert.doesNotMatch(source, /com\.mentra\.bluetoothsdkexample|starterKitCommit/)
  }
  assert.doesNotMatch(mobile, /starter-kit-ios:|starter-kit-android:|reusable-production-starter-kit-android/)
  assert.match(mobile, /needs: \[load, mentra-app\]/)
  const androidFastfile = mobileFastfile("fastlane-android")
  assert.match(androidFastfile, /version_name: ENV\["GOOGLE_PLAY_RELEASE_NAME"\]/)
  assert.doesNotMatch(androidFastfile, /release_name:/)
  assert.match(mobile, /release_id: \$\{\{ needs\.load\.outputs\.promotion_release_id \}\}/)
  assert.match(mobile, /artifact_container_tag: \$\{\{ needs\.load\.outputs\.candidate_container_tag \}\}/)
  assert.doesNotMatch(mobile, /allocate stable artifact container/i)
  assert.match(submit, /GOOGLE_PLAY_RELEASE_STATUS=draft/)
  assert.doesNotMatch(submit, /automatic_release: true/)
  assert.doesNotMatch(release, /automatic_release: true/)
  assert.match(rollout, /\[\[ "\$percent" -lt 100 \]\]/)
  assert.match(rollout, /\[\[ "\$percent" -gt "\$previous" \]\]/)
  assert.match(rollout, /\.evidence\[\]\.assetName/)
  assert.match(rollout, /to=finalizing/)
  assert.match(rollout, /finalize-production-promotion\.mjs/)
  assert.match(rollout, /\.artifactNames\.releasePlan/)
  assert.match(rollout, /\.artifactNames\.releaseManifest/)
  assert.match(rollout, /checkpoint_name=.*promotionAssetName/)
  assert.match(rollout, /releases\/download\/\$tag\/\$checkpoint_name/)
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

test("stable packages publish from the frozen beta source independently of the mobile path", () => {
  const packages = workflow("production-release-packages.yml")
  const rollout = workflow("production-release-rollout.yml")
  const sdkNative = workflow("reusable-coordinated-sdk-native.yml")

  assert.match(packages, /workflow_dispatch:/)
  assert.doesNotMatch(packages, /pull_request:/)
  assert.match(packages, /ref: main/)
  assert.match(packages, /beta_identity:/)
  assert.match(packages, /options:\n\s+- publish\n\s+- release/)
  // Keyed on the beta plan, built from its exact source, only once main contains it.
  assert.match(packages, /git merge-base --is-ancestor "\$source_commit" origin\/main/)
  assert.match(packages, /ref: \$\{\{ steps\.beta\.outputs\.source_commit \}\}/)
  assert.match(packages, /production-packages\.mjs plan \\\n\s+--root release-source/)
  assert.match(packages, /source_commit: \$\{\{ needs\.load\.outputs\.source_commit \}\}/)
  // The promotion state machine is read only, to refuse a conflicting frozen beta.
  assert.match(packages, /download-latest-attempt/)
  assert.match(packages, /production-promotion-state\.mjs packages-guard/)
  assert.doesNotMatch(packages, /production-promotion-state\.mjs (transition|append|attest-transition)/)
  assert.doesNotMatch(packages, /publish-record|--to [a-z-]+/)
  assert.doesNotMatch(
    packages,
    /stores-approved|store-review-approved|production-store-release|production-cloud|reusable-coordinated-cloud-v2|reusable-coordinated-mobile/,
  )
  assert.match(packages, /group: production-release-packages\n/)
  // Every target is checked before the first irreversible mutation.
  const releaseJob = jobBlock(packages, "release")
  const firstMutation = releaseJob.indexOf("Move npm latest to the staged plain versions")
  for (const preflight of [
    "Preflight npm without moving any dist-tag",
    "Preflight the validated Sonatype deployment",
    "Preflight the staged SwiftPM commit against its archived export",
  ]) {
    const index = releaseJob.indexOf(preflight)
    assert.notEqual(index, -1, preflight)
    assert.ok(index < firstMutation, `${preflight} must precede the npm latest flip`)
  }
  assert.match(releaseJob, /--dry-run true/)
  assert.match(releaseJob, /git get-tar-commit-id/)
  assert.doesNotMatch(releaseJob, /cmp /)
  // Staging and public release are separate protected approvals.
  assert.match(packages, /name: production-packages\n/)
  assert.match(packages, /name: production-packages-release\n/)
  assert.match(packages, /npm_tag: \$\{\{ needs\.load\.outputs\.npm_tag \}\}/)
  assert.match(packages, /promote-npm-latest\.mjs/)
  assert.match(packages, /sonatype-central-deployment\.mjs publish/)
  assert.match(packages, /git push origin "refs\/tags\/\$VERSION"/)
  assert.match(packages, /release_id: \$\{\{ needs\.load\.outputs\.stable_release_id \}\}/)
  // Both workflows must recognize the same stable draft container.
  assert.match(
    rollout,
    /body: "Canonical production release records\. Publish manually only after the completed promotion and final public-availability checks\."/,
  )
  assert.match(packages, /production-packages\.mjs ensure-container/)
  // The reusable native job stages production without publishing, using
  // registry tooling from the workflow revision rather than the frozen source.
  assert.match(sdkNative, /publishing_type=USER_MANAGED/)
  assert.match(sdkNative, /ref: \$\{\{ github\.sha \}\}\n\s+path: release-tooling/)
  assert.match(sdkNative, /release-tooling\/\.github\/scripts\/sonatype-central-deployment\.mjs upload/)
  assert.match(sdkNative, /release-tooling\/\.github\/scripts\/sonatype-central-deployment\.mjs inspect/)
  assert.doesNotMatch(sdkNative, /node \.github\/scripts\/sonatype-central-deployment\.mjs/)
  assert.match(sdkNative, /--publishing-type "\$PUBLISHING_TYPE"/)
  assert.match(sdkNative, /\.publishingType native-result\/maven\/sonatype-deployment\.json\)" == "\$PUBLISHING_TYPE"/)
  assert.match(sdkNative, /sonatype-central-deployment\.mjs wait-validated/)
  assert.match(sdkNative, /staging_ref="release\/\$version"/)
  assert.match(
    sdkNative,
    /steps\.release\.outputs\.channel != 'production' && steps\.existing\.outputs\.exists != 'true'/,
  )
  assert.match(
    sdkNative,
    /git push origin "\$\{\{ steps\.selected\.outputs\.mirror_sha \}\}:refs\/heads\/\$STAGING_REF"/,
  )
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
  // Porter's CLI otherwise tags from GITHUB_SHA, which on a workflow_dispatch
  // from main is the dispatching commit, not the frozen source; the deploy
  // verifies the observed image tag against the source, so the tag is explicit.
  assert.match(cloud, /PORTER_TAG: \$\{\{ steps\.source\.outputs\.tag \}\}/)
  assert.match(cloud, /--tag "\$PORTER_TAG" \\/)
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
  assert.match(jobBlock(example, "ios"), /runs-on: macos-15/)
  assert.match(jobBlock(example, "ios"), /DEVELOPER_DIR: \/Applications\/Xcode_26\.2\.app\/Contents\/Developer/)
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
  const plan = jobBlock(coordinator, "plan")
  const starterKitJob = jobBlock(coordinator, "starter-kit")
  // The Starter Kit request is shared with the production example: the
  // coordinator only wires the reusable workflow.
  const starterKit = jobBlock(workflow("reusable-coordinated-starter-kit.yml"), "starter-kit")
  const engineConsumer = jobBlock(coordinator, "engine-consumer")
  const exampleTestflight = jobBlock(coordinator, "example-testflight")
  const docs = jobBlock(coordinator, "docs")
  const notify = jobBlock(coordinator, "notify-slack")

  const finalize = jobBlock(coordinator, "finalize")
  const finalizeExample = jobBlock(coordinator, "finalize-example")

  // The Mentra beta (Cloud V2, Mentra App, Engine, Bluetooth SDK) is complete
  // on its own; the Bluetooth example is built against the finalized beta and
  // finalized as a separate record, so it can never make the beta incomplete.
  assert.match(finalize, /^    needs: \[plan, cloud-v2, ota, npm, sdk-native, mobile, engine-consumer\]$/m)
  assert.doesNotMatch(finalize, /starter-kit|example-testflight|example-google-play/)
  assert.match(starterKitJob, /^    needs: \[plan, ota, npm, sdk-native, finalize\]$/m)
  assert.match(starterKitJob, /uses: \.\/\.github\/workflows\/reusable-coordinated-starter-kit\.yml/)
  assert.match(starterKitJob, /if: needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(engineConsumer, /^    needs: \[plan, npm\]$/m)
  assert.match(starterKit, /coordinated-example-release\.yml/)
  assert.match(starterKit, /production\) target_branch=main ;;/)
  assert.match(starterKit, /container_tag="sdk-\$identity"/)
  assert.doesNotMatch(coordinator, /Freeze the Starter Kit channel source/)
  assert.doesNotMatch(coordinator, /--starter-kit-source|starterKitSource|Starter-Kit-Source/)
  assert.match(
    finalizeExample,
    /^    needs: \[plan, finalize, starter-kit, example-testflight, example-google-play\]$/m,
  )
  assert.match(finalizeExample, /needs\.finalize\.result == 'success'/)
  assert.match(finalizeExample, /needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(finalizeExample, /name: coordinated-release-result-\$\{\{ needs\.plan\.outputs\.release_set_id \}\}/)
  assert.match(finalizeExample, /example-release-records\.mjs/)
  assert.match(finalizeExample, /--beta-manifest "\$beta_manifest"/)
  assert.match(finalizeExample, /record_name="mentra-example-release-\$identity\.json"/)
  assert.match(finalizeExample, /publish-immutable-release-asset\.mjs/)
  assert.match(finalizeExample, /verify-public-release-asset\.mjs/)
  // Retries are idempotent: the Starter Kit head the earlier attempt used is
  // recovered from its candidate (or release tag), and an already-published
  // example record is reproduced byte-for-byte instead of re-minted.
  assert.match(
    starterKit,
    /candidate_parent=\$\(gh api "repos\/\$STARTER_KIT_REPOSITORY\/commits\/coordinated\/\$identity" --jq '\.parents\[0\]\.sha'/,
  )
  assert.match(starterKit, /commits\/sdk-\$identity" --jq '\.parents\[0\]\.sha'/)
  assert.match(finalizeExample, /--output existing-record\.json/)
  assert.match(finalizeExample, /completed_at=\$\(jq -er \.completedAt existing-record\.json\)/)
  assert.match(finalizeExample, /cmp existing-record\.json "finalized-example\/\$record_name"/)
  assert.match(finalizeExample, /--completed-at "\$completed_at"/)
  assert.match(plan, /Restore the release plan selected by an earlier attempt/)
  assert.match(plan, /actions\/runs\/\$GITHUB_RUN_ID\/artifacts/)
  assert.match(plan, /gh run download "\$GITHUB_RUN_ID"/)
  assert.match(plan, /output=release-plan\.verify\.json/)
  assert.match(plan, /cmp release-plan\.json "\$output"/)
  assert.equal([...plan.matchAll(/if: steps\.restore-plan\.outputs\.restored != 'true'/g)].length, 1)
  assert.doesNotMatch(plan, /source_timestamp/)
  assert.match(
    starterKit,
    /expected_head=\$\(git ls-remote "https:\/\/github\.com\/\$STARTER_KIT_REPOSITORY\.git" "refs\/heads\/\$target_branch"/,
  )
  assert.doesNotMatch(starterKit, /expected_head=\$\(gh api/)
  assert.doesNotMatch(starterKit, /event_type: "coordinated_example_release"/)
  assert.doesNotMatch(starterKit, /--event repository_dispatch/)
  assert.match(starterKit, /gh workflow run coordinated-example-release\.yml/)
  assert.match(starterKit, /--ref "\$target_branch"/)
  assert.match(starterKit, /--event workflow_dispatch/)
  assert.equal([...starterKit.matchAll(/--branch "\$target_branch"/g)].length, 2)
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
  assert.match(starterKit, /permission-actions: write/)
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
  assert.match(finalize, /needs\.engine-consumer\.result == 'success'/)
  assert.match(docs, /^    needs: \[plan, starter-kit, example-testflight, finalize, finalize-example\]$/m)
  assert.match(docs, /needs\.starter-kit\.result == 'success'/)
  assert.match(docs, /needs\.finalize\.result == 'success'/)
  assert.match(docs, /needs\.finalize-example\.result == 'success'/)
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
    /^    needs:\n      \[plan, cloud-v2, ota, npm, sdk-native, mobile, engine-consumer, starter-kit, example-testflight, example-google-play, finalize, finalize-example, docs\]$/m,
  )
  assert.match(notify, /FINALIZE_EXAMPLE_RESULT: \$\{\{ needs\.finalize-example\.result \}\}/)
  assert.match(notify, /STARTER_KIT_RESULT: \$\{\{ needs\.starter-kit\.result \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_RESULT: \$\{\{ needs\.example-testflight\.result \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_INSTALL_URL: \$\{\{ needs\.example-testflight\.outputs\.install_url \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_BUILD_NUMBER: \$\{\{ needs\.example-testflight\.outputs\.build_number \}\}/)
  assert.match(notify, /EXAMPLE_GOOGLE_PLAY_RESULT: \$\{\{ needs\.example-google-play\.result \}\}/)
  assert.match(notify, /EXAMPLE_GOOGLE_PLAY_TRACK: \$\{\{ needs\.plan\.outputs\.example_play_track \}\}/)
  assert.match(notify, /EXAMPLE_GOOGLE_PLAY_INSTALL_URL: \$\{\{ needs\.example-google-play\.outputs\.install_url \}\}/)
  assert.match(notify, /STARTER_KIT_RUN_URL: \$\{\{ needs\.starter-kit\.outputs\.run_url \}\}/)
  assert.match(notify, /DOCS_RESULT: \$\{\{ needs\.docs\.result \}\}/)
  const example = workflow("reusable-coordinated-example-testflight.yml")
  assert.match(example, /actions\/create-github-app-token@v3/)
  assert.match(example, /private-key: \$\{\{ secrets\.STARTER_KIT_COORDINATOR_APP_PRIVATE_KEY \}\}/)
  assert.match(example, /continue-on-error: true/)
  assert.doesNotMatch(example, /STARTER_KIT_APP_PRIVATE_KEY:/)
  assert.match(example, /permission-contents: read/)
  assert.doesNotMatch(example, /group: mentra-ios-signing-runner/)
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

test("iOS publishes the signed artifact before submitting those same bytes to Apple", () => {
  const source = workflow("reusable-coordinated-mobile.yml")
  const build = jobBlock(source, "ios")
  const publish = jobBlock(source, "ios-publish")
  const upload = jobBlock(source, "ios-upload")
  const store = jobBlock(source, "ios-store")
  assert.doesNotMatch(build, /publish-immutable-release-asset\.mjs|app-store-connect-build\.mjs upload/)
  assert.match(build, /actions\/upload-artifact@v4/)
  assert.match(publish, /needs: \[prepare, ios\]/)
  assert.match(publish, /runs-on: ubuntu-latest/)
  assert.match(publish, /timeout-minutes: 5/)
  assert.match(publish, /needs\.ios\.outputs\.upload_artifact/)
  assert.match(publish, /publish-immutable-release-asset\.mjs/)
  assert.match(
    publish,
    /inputs\.dry_run != true && inputs\.compatibility_lab != true && needs\.prepare\.outputs\.ios_asset_exists != 'true'/,
  )
  assert.match(upload, /needs: \[prepare, ios, ios-publish\]/)
  assert.match(upload, /needs\.ios\.outputs\.upload_artifact/)
  assert.match(upload, /app-store-connect-build\.mjs upload/)
  assert.match(store, /needs: \[prepare, ios, ios-upload\]/)
  assert.match(store, /needs\.ios-upload\.outputs\.upload_status/)
})

test("iOS status reports the failed phase instead of downstream skips", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ios-status-"))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const status = jobBlock(workflow("reusable-coordinated-mobile.yml"), "status")
  const script = status.split("        run: |\n")[1].replace(/^          /gm, "")
  for (const [build, publish, upload, store, expected] of [
    ["success", "success", "success", "success", "success"],
    ["failure", "skipped", "skipped", "skipped", "failure"],
    ["success", "failure", "skipped", "skipped", "failure"],
    ["success", "success", "cancelled", "skipped", "cancelled"],
    ["success", "success", "success", "failure", "failure"],
  ]) {
    const output = path.join(dir, `${build}-${publish}-${upload}-${store}`)
    const result = spawnSync("bash", ["-eu", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        ANDROID_RESULT: "success",
        IOS_BUILD_RESULT: build,
        IOS_PUBLISH_RESULT: publish,
        IOS_UPLOAD_RESULT: upload,
        IOS_STORE_RESULT: store,
        APK_NAME: "app.apk",
        IPA_NAME: "app.ipa",
        ASSET_BASE_URL: "https://example.com",
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(output, "utf8"), new RegExp(`^ios_result=${expected}$`, "m"))
  }
})

test("Play lane outputs in the production workflows are absolute paths", () => {
  // fastlane runs every lane from inside the fastlane/ directory, so a
  // relative output path lands one level deeper than the caller expects.
  for (const name of [
    "production-release-prepare.yml",
    "production-release-status.yml",
    "production-release-store-release.yml",
    "production-release-store-submit.yml",
    "production-release-example.yml",
  ]) {
    const source = workflow(name)
    for (const match of source.matchAll(/GOOGLE_PLAY_[A-Z_]*OUTPUT=(\S+)/g)) {
      assert.match(match[1], /^"\$GITHUB_WORKSPACE\//, `${name}: ${match[0]}`)
    }
  }
})

test("the production example is keyed on the promoted beta and never promotes a store listing", () => {
  const example = workflow("production-release-example.yml")
  const load = jobBlock(example, "load")
  const finalize = jobBlock(example, "finalize-example")
  const play = workflow("reusable-coordinated-example-google-play.yml")

  assert.match(example, /group: production-release-example\n/)
  assert.match(load, /environment:\n      name: production-store-status/)
  assert.match(load, /git merge-base --is-ancestor "\$source_commit" origin\/main/)
  assert.match(load, /npm view "\$name@\$RELEASE_IDENTITY" version/)
  assert.match(load, /production-example\.mjs plan/)
  assert.match(load, /--apple-inventory example-input\/stores\/example-apple\.json/)
  assert.match(load, /GOOGLE_PLAY_INVENTORY_OUTPUT="\$GITHUB_WORKSPACE\/example-input\/stores\/example-google\.json"/)
  assert.match(load, /production-packages\.mjs ensure-container/)
  assert.match(example, /uses: \.\/\.github\/workflows\/reusable-coordinated-starter-kit\.yml/)
  assert.match(example, /uses: \.\/\.github\/workflows\/reusable-coordinated-example-testflight\.yml/)
  assert.match(example, /uses: \.\/\.github\/workflows\/reusable-coordinated-example-google-play\.yml/)
  assert.match(example, /production_build_number: \$\{\{ fromJSON\(needs\.load\.outputs\.build_number\) \}\}/)
  assert.match(finalize, /example-release-records\.mjs/)
  assert.match(load, /Recover the example plan a previous run already froze/)
  assert.match(load, /--existing-plan example-input\/existing-plan\.json/)
  assert.match(load, /cp release-intent\/release-plan\.json "release-intent\/\$PLAN_ASSET"/)
  assert.match(load, /--file "release-intent\/\$PLAN_ASSET" \\\n\s+--name "\$PLAN_ASSET"/)
  assert.doesNotMatch(load, /mv "[^"]*" "\1"/)
  assert.match(finalize, /example-release-records\.mjs reconcile/)
  assert.match(finalize, /if: steps\.results\.outputs\.published != 'true'/)
  assert.doesNotMatch(finalize, /cmp existing-record\.json/)
  assert.match(play, /if \[\[ "\$\(jq -er \.channel "\$plan"\)" == "production" \]\]; then/)
  assert.match(play, /target_commitish <<< "\$release"\)" == "\$\(jq -er \.sourceCommit "\$plan"\)"/)
  assert.match(finalize, /publish-immutable-release-asset\.mjs/)
  assert.doesNotMatch(
    example,
    /production-status|store-submit|store-release|rollout|submit-for-review|app-store-version/i,
  )
  assert.doesNotMatch(example, /production-store-submission|production-store-release/)
  // The Play lane runs its scripts from the workflow revision so a promoted
  // beta that predates production support can still build the example.
  assert.match(play, /Checkout example tooling from the workflow revision/)
  assert.equal(
    [...play.matchAll(/release-tooling\/\.github\/scripts\/coordinated-example-google-play\.mjs/g)].length,
    4,
  )
  assert.doesNotMatch(play, /node \.github\/scripts\/coordinated-example-google-play\.mjs/)
  const testflight = workflow("reusable-coordinated-example-testflight.yml")
  assert.match(testflight, /release-tooling\/\.github\/scripts\/coordinated-example-testflight-record\.mjs/)
  assert.doesNotMatch(testflight, /node \.github\/scripts\/coordinated-example-testflight-record\.mjs/)
  assert.match(testflight, /elif \.channel == "production" then "Mentra Bluetooth Example"/)
  assert.match(testflight, /if \.channel == "dev" then "internal" else "external" end/)
  assert.doesNotMatch(example + testflight, /Mentra SDK Example|Production Candidates/)
  assert.equal(existsSync(new URL("../workflows/reusable-production-starter-kit-android.yml", import.meta.url)), false)
})

// Every publish-immutable-release-asset.mjs invocation in a workflow, as its
// raw --file and --name arguments. Each invocation is cut at its own
// --repository argument so one call can never borrow another's arguments.
export function immutablePublishArguments(source) {
  const invocations = []
  const parts = source.split("publish-immutable-release-asset.mjs")
  for (const part of parts.slice(1)) {
    const scope = part.split("--repository")[0]
    const argument = (flag) => {
      const match = new RegExp(`${flag}\\s+(?:"([^"]*)"|(\\S+))`).exec(scope)
      return match ? (match[1] ?? match[2]) : null
    }
    invocations.push({file: argument("--file"), name: argument("--name")})
  }
  return invocations
}

// A --file whose basename is not the --name fails at publication time. Two
// spellings are accepted: the basename of the file string equals the name
// string (plain names, "$variable" names, and "${{ ... }}" expressions alike),
// or both are the asset_path and asset_name outputs of the same step, which
// prepareEvidenceAsset in production-promotion-assets.mjs derives together.
export function immutablePublishMismatches(source) {
  return immutablePublishArguments(source).filter(({file, name}) => {
    if (!file || !name) return true
    if (file.split("/").pop() === name) return false
    const pathOutput = /^\$\{\{ steps\.([a-z-]+)\.outputs\.asset_path \}\}$/.exec(file)
    const nameOutput = /^\$\{\{ steps\.([a-z-]+)\.outputs\.asset_name \}\}$/.exec(name)
    return !(pathOutput && nameOutput && pathOutput[1] === nameOutput[1])
  })
}

test("immutable assets in every production workflow are published from a file named like the asset", () => {
  const names = readdirSync(new URL("../workflows/", import.meta.url)).filter((name) =>
    /^production-release-.*\.yml$/.test(name),
  )
  assert.ok(names.length >= 10, `expected the production workflows, found ${names.length}`)
  let invocations = 0
  for (const name of names) {
    const source = workflow(name)
    invocations += immutablePublishArguments(source).length
    assert.deepEqual(immutablePublishMismatches(source), [], `${name} publishes an asset under another name`)
  }
  assert.ok(invocations >= 18, `expected every publisher invocation to be inspected, found ${invocations}`)
})

test("the immutable publish contract inspects each invocation on its own", () => {
  const snippet = `
          node .github/scripts/publish-immutable-release-asset.mjs \\
            --file "promotion-output/$plan_name" \\
            --name "$plan_name" \\
            --release-id "1" \\
            --repository "$GITHUB_REPOSITORY"
          node .github/scripts/publish-immutable-release-asset.mjs \\
            --file promotion-input/current/release-plan.json \\
            --name current-production-release-plan.json \\
            --release-id "1" \\
            --repository "$GITHUB_REPOSITORY"
          node .github/scripts/publish-immutable-release-asset.mjs --file "\${{ steps.a.outputs.asset_path }}" --name "\${{ steps.b.outputs.asset_name }}" --release-id "1" --repository "$GITHUB_REPOSITORY"
          node .github/scripts/publish-immutable-release-asset.mjs --file "\${{ steps.a.outputs.asset_path }}" --name "\${{ steps.a.outputs.asset_name }}" --release-id "1" --repository "$GITHUB_REPOSITORY"
          node .github/scripts/publish-immutable-release-asset.mjs \\
            --file promotion-input/stores/current-production-store-inventory.json \\
            --name current-production-store-inventory.json \\
            --release-id "1" \\
            --repository "$GITHUB_REPOSITORY"
  `
  assert.equal(immutablePublishArguments(snippet).length, 5)
  assert.deepEqual(
    immutablePublishMismatches(snippet).map(({name}) => name),
    ["current-production-release-plan.json", "\${{ steps.b.outputs.asset_name }}"],
  )
})
