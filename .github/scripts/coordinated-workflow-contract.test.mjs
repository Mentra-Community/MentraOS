import assert from "node:assert/strict"
import {existsSync, readFileSync, mkdtempSync, readdirSync, rmSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {TARGETS as PRIVATE_DEPLOYMENT_TARGETS} from "./coordinated-private-deployment-records.mjs"

function workflow(name) {
  return readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
}

function mobileScript(name) {
  return readFileSync(new URL(`../../mobile/scripts/${name}`, import.meta.url), "utf8")
}

function mobileFastfile(name) {
  return readFileSync(new URL(`../../mobile/ci/${name}/Fastfile`, import.meta.url), "utf8")
}

function repositoryScript(name) {
  return readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8")
}

function jobBlock(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `Missing workflow job ${name}`)
  const rest = source.slice(start + 1)
  const next = rest.slice(1).search(/^  [a-z0-9-]+:\n/m)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

test("the public Engine iOS consumer keeps Mapbox credentials with both Pod and SPM resolution", () => {
  const ios = jobBlock(workflow("reusable-coordinated-engine-consumer.yml"), "ios")
  const home = "HOME: ${{ runner.temp }}/engine-consumer-home-${{ github.run_id }}-${{ github.run_attempt }}"
  const step = (name) => ios.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0]
  for (const name of ["Configure Mapbox package access", "Prebuild and resolve the autolinked iOS host", "Compile the external iOS host without signing", "Remove this job's Mapbox credentials"]) {
    assert.ok(step(name)?.includes(home), `${name} must use the same private credential home`)
  }
  assert.match(step("Remove this job's Mapbox credentials"), /if: always\(\)/)
  assert.match(step("Remove this job's Mapbox credentials"), /rm -f "\$HOME\/\.netrc"/)
})

test("every internal release-asset fetch has authenticated R2 credentials in its step scope", () => {
  const directory = new URL("../workflows/", import.meta.url)
  let fetchSteps = 0
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".yml"))) {
    const source = workflow(name)
    for (const step of source.split(/^      - /m).slice(1)) {
      if (!/release-assets\.mjs(?:"|')?\s+fetch/.test(step)) continue
      fetchSteps++
      const configuration = step.split(/\n        run:/)[0]
      for (const key of ["ARTIFACTS_R2_ACCESS_KEY_ID", "ARTIFACTS_R2_SECRET_ACCESS_KEY"]) {
        assert.ok(configuration.includes(`${key}: \${{ secrets.${key} }}`), `${name}: ${step.split("\n")[0]} needs ${key}`)
      }
      assert.match(source, /ARTIFACTS_R2_ACCOUNT_ID: \$\{\{ vars\.ARTIFACTS_R2_ACCOUNT_ID \}\}/, name)
    }
  }
  assert.ok(fetchSteps >= 5, "Expected the mobile reuse, marker and Sonatype-record fetch callers")
})


test("ASG publication restores Node and npm after runner disk cleanup", () => {
  const build = jobBlock(workflow("mentra-asg-client-build.yml"), "build")
  const cleanup = build.indexOf("/usr/local/lib/node_modules")
  const setup = build.indexOf("uses: actions/setup-node@v4", cleanup)
  assert.ok(cleanup > 0 && setup > cleanup)
  assert.ok(build.indexOf("publish-immutable-release-asset.mjs", setup) > setup)
})

test("mobile records and notifications use per-artifact storage URLs", () => {
  const mobile = workflow("reusable-coordinated-mobile.yml")
  const prepare = jobBlock(mobile, "prepare")
  assert.match(prepare, /release-assets\.mjs" urls/)
  assert.match(prepare, /--allow-missing true/)
  for (const kind of ["apk", "aab", "ipa"]) {
    assert.ok(
      prepare.includes(`${kind}_url: \${{ steps.container.outputs.${kind}_url || steps.release.outputs.${kind}_url }}`),
    )
    assert.ok(mobile.includes(`--${kind}-url "\${{ needs.prepare.outputs.${kind}_url }}"`))
  }
  assert.doesNotMatch(mobile, /asset_base_url/)
  const coordinator = workflow("coordinated-release.yml")
  assert.match(coordinator, /MOBILE_APK_URL: \$\{\{ needs.mobile.outputs.apk_url \}\}/)
  assert.match(coordinator, /MOBILE_IPA_URL: \$\{\{ needs.mobile.outputs.ipa_url \}\}/)
})

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

test("coordinated release retries restore the finalized immutable result", () => {
  const finalize = jobBlock(workflow("coordinated-release.yml"), "finalize")
  const restore = finalize.indexOf("name: Restore finalized release result from an earlier attempt")
  const resultDownload = finalize.indexOf("name: ${{ needs.cloud-v2.outputs.result_artifact }}")
  const assemble = finalize.indexOf("name: Assemble complete publication evidence")
  const persist = finalize.indexOf("name: coordinated-release-result-")
  const publish = finalize.indexOf("name: Publish immutable plan, package, and manifest assets")

  assert.ok(restore >= 0 && restore < resultDownload)
  assert.ok(resultDownload < assemble)
  assert.ok(assemble < persist && persist < publish)
  assert.match(finalize, /cmp "\$plan" "restored-release\/\$plan_name"/)
  assert.match(finalize, /\.releaseSetId/)
  assert.match(finalize, /\.sourceCommit/)
  assert.match(finalize, /Finalize release manifest\n        if: .*steps\.restore-result\.outputs\.restored != 'true'/)
  assert.match(finalize, /name: Restore finalized release result from an earlier attempt\n        id: restore-result\n        if: needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(finalize, /actions\/upload-artifact@v4\n        if: needs\.plan\.outputs\.dry_run != 'true' && steps\.restore-result\.outputs\.restored != 'true'/)
})

test("each channel has one release page writer, which lists the example apps", () => {
  const core = workflow("coordinated-release.yml")
  const finalize = jobBlock(core, "finalize")
  assert.doesNotMatch(finalize, /publish-coordinated-release-page/)
  const page = jobBlock(core, "release-page")
  assert.match(page, /needs: \[plan, finalize, examples\]/)
  assert.match(page, /if: always\(\) && needs\.plan\.outputs\.dry_run != 'true' && needs\.finalize\.result == 'success'/)
  assert.match(page, /name: coordinated-release-result-/)
  assert.match(page, /--examples "\$\{\{ needs\.examples\.result == 'success' \}\}"/)
  assert.doesNotMatch(page, /finalize-release-manifest|publish-immutable-release-asset|date -u/)
  assert.equal([...core.matchAll(/publish-coordinated-release-page\.mjs/g)].length, 1)
  // One Slack message carries the examples and docs too.
  assert.doesNotMatch(core, /notify-slack-examples|RELEASE_SCOPE/)
  const notify = jobBlock(core, "notify-slack")
  assert.match(notify, /if: always\(\) && github\.event_name == 'push'/)
  for (const job of ["examples", "example-testflight", "example-google-play", "docs", "release-page"]) {
    assert.match(notify, new RegExp(`^        ${job},$`, "m"), job)
  }
  for (const kind of ["apk", "ipa"]) {
    assert.ok(notify.includes(`MOBILE_${kind.toUpperCase()}_URL: \${{ needs.mobile.outputs.${kind}_url }}`))
  }
})

test("Cloud V2 readiness gates mobile compilation and publication", () => {
  const coordinator = workflow("coordinated-release.yml")
  const cloud = workflow("reusable-coordinated-cloud-v2.yml")
  const cloudJob = jobBlock(coordinator, "cloud-v2")
  const mobile = jobBlock(coordinator, "mobile")
  const finalize = jobBlock(coordinator, "finalize")
  const notify = jobBlock(coordinator, "notify-slack")

  // Dev releases come from the Mentra monorepo; this coordinator serves staging.
  assert.doesNotMatch(coordinator, /cloud_environment=dev/)
  assert.match(coordinator, /cloud_environment=staging/)
  assert.doesNotMatch(coordinator, /backend_environment=dev/)
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
  // The frozen source may predate tooling fixes on main; scripts run from the
  // workflow revision, which is the same revision the workflow file came from.
  assert.match(cloud, /ref: \$\{\{ github\.sha \}\}\n\s+path: release-tooling/)
  assert.doesNotMatch(cloud, /node \.github\/scripts\//)
  assert.match(cloud, /node release-tooling\/\.github\/scripts\/coordinated-cloud-v2-records\.mjs resolve/)
  assert.match(cloud, /node release-tooling\/\.github\/scripts\/coordinated-cloud-v2-records\.mjs create/)
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

for (const readyOnAttempt of [2, 13]) {
  test(`Cloud deployment records use each fresh Pod read (${readyOnAttempt === 2 ? "settles" : "never ready"})`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cloud-deployment-settlement-"))
    const step = workflow("reusable-coordinated-cloud-v2.yml")
      .split("      - name: Require settled deployment and Runtime disruption policy\n")[1]
      .split("        run: |\n")[1]
      .split("\n      - name:")[0]
      .replace(/^          /gm, "")
      .replace(/\$\{\{ inputs\.deployment_environment \}\}/g, "dev")
      .replace(/\$\{\{ inputs\.source_commit \}\}/g, "source-commit")
      .replace(/\$\{\{ steps\.source\.outputs\.tag \}\}/g, "source-commit")
      .replace(/\$\{\{ github\.repository \}\}/g, "Mentra-Community/MentraOS")
      .replace(/\$\{\{ github\.run_id \}\}/g, "123")
    // Existing record validation tests enforce readiness, exact tags and digest.
    // Here the real workflow shell must reread its observation before each call.
    const mocks = `
      porter() {
        if [[ "$*" == *"get pods"* ]]; then
          local count=0
          [[ ! -f pod-reads ]] || read -r count < pod-reads
          count=$((count + 1)); echo "$count" > pod-reads
          printf '{"attempt":%s}\n' "$count"
        else
          echo '{"kind":"List","items":[]}'
        fi
      }
      jq() { [[ "$*" == "-er .runtimeReplicas cloud-v2-rendered-config.json" ]] && echo 1; }
      sleep() { :; }
      node() {
        if [[ "$1" == *verify-runtime-deployment-policy.mjs ]]; then return 0; fi
        [[ "$1" == *coordinated-cloud-v2-records.mjs && "$2" == create ]] || return 1
        [[ "$*" == *"--source-commit source-commit"* && "$*" == *"--requested-tag source-commit"* &&
          "$*" == *"--status deployed"* && "$*" == *"--pods cloud-v2-pods.json"* ]] || return 1
        local count; read -r count < pod-reads
        [[ "$(cat cloud-v2-pods.json)" == "$(printf '{\"attempt\":%s}' "$count")" ]] || return 1
        echo "$count" >> record-attempts
        [[ "$count" -ge "$READY_ON_ATTEMPT" ]] || return 1
        echo "$count" > cloud-v2-deployment.json
      }
    `
    try {
      const result = spawnSync("bash", ["-eu", "-c", `${mocks}\n${step}`], {
        cwd: directory, env: {...process.env, PORTER_APP_NAME: "cloud-dev", READY_ON_ATTEMPT: String(readyOnAttempt)},
        encoding: "utf8", timeout: 5000,
      })
      assert.equal(result.status, readyOnAttempt === 2 ? 0 : 1, result.stderr)
      assert.equal(Number(readFileSync(path.join(directory, "pod-reads"))), Math.min(readyOnAttempt, 12))
      assert.equal(existsSync(path.join(directory, "cloud-v2-deployment.json")), readyOnAttempt === 2)
      assert.equal(readFileSync(path.join(directory, "record-attempts"), "utf8").trim().split("\n").length,
        Math.min(readyOnAttempt, 12))
    } finally {rmSync(directory, {recursive: true, force: true})}
  })
}

test("Private Deployment remains release-matched without gating the release", () => {
  const coordinator = workflow("coordinated-release.yml")
  const runtimeImage = workflow("reusable-coordinated-runtime-image.yml")
  const privateDeployment = workflow("private-deployment.yml")
  const runtimeImageJob = jobBlock(coordinator, "runtime-image")
  const privateDeploymentJob = jobBlock(coordinator, "private-deployment")
  const finalize = jobBlock(coordinator, "finalize")
  const notify = jobBlock(coordinator, "notify-slack")

  assert.match(runtimeImageJob, /^    needs: plan$/m)
  assert.match(runtimeImageJob, /reusable-coordinated-runtime-image\.yml/)
  assert.match(runtimeImage, /ghcr\.io\/mentra-community\/mentra-cloud/)
  assert.match(runtimeImage, /docker\/build-push-action@/)
  assert.match(runtimeImage, /anchore\/sbom-action@/)
  assert.equal((runtimeImage.match(/uses: actions\/attest@/g) || []).length, 3)
  assert.match(runtimeImage, /tags: \$\{\{ steps\.coordinates\.outputs\.temporary_tag \}\}/)
  assert.match(runtimeImage, /provenance: false/)
  assert.ok(
    runtimeImage.indexOf("- name: Attest new build provenance") <
      runtimeImage.indexOf("- name: Publish immutable release and source tags"),
  )
  assert.match(runtimeImage, /- name: Verify reused image provenance/)
  assert.match(runtimeImage, /--predicate-type https:\/\/spdx\.dev\/Document\/v2\.3/)
  assert.match(runtimeImage, /coordinated-runtime-image-records\.mjs create/)
  const packageStep = runtimeImage.indexOf("- name: Package Azure installer for the published image")
  const attestStep = runtimeImage.indexOf("- name: Attest Azure installer")
  const uploadStep = runtimeImage.indexOf("- name: Upload Azure installer")
  const packageRetry = runtimeImage.slice(runtimeImage.indexOf("- name: Package Azure installer"), runtimeImage.indexOf("- name: Attest Azure installer"))
  assert.match(packageRetry, /gh attestation verify installer-existing\.tar\.gz/)
  assert.match(packageRetry, /release\['installerSourceCommit'\]/)
  assert.match(packageRetry, /refusing to replace immutable bytes/)
  assert.match(packageRetry, /mv installer-existing\.tar\.gz mentra-private-cloud\.tar\.gz/)
  const deliveryStep = runtimeImage.indexOf("- name: Publish persistent installer downloads")
  assert.ok(deliveryStep > uploadStep)
  const delivery = runtimeImage.slice(deliveryStep, runtimeImage.indexOf("- name: Name coordinated result artifact"))
  assert.match(delivery, /ensure-installer-release\.mjs/)
  assert.doesNotMatch(delivery, /gh release create|installer-release-response/)
  assert.match(delivery, /publish-immutable-release-asset\.mjs/)
  assert.match(delivery, /mentra-private-cloud\.tar\.gz\.sha256/)
  assert.match(delivery, /ARTIFACTS_R2_SECRET_ACCESS_KEY/)
  assert.match(runtimeImageJob, /contents: write/)
  const verificationStep = runtimeImage.indexOf("- name: Verify signed Mentra Cloud attestations")
  assert.ok(verificationStep >= 0 && packageStep > verificationStep)
  assert.ok(attestStep > packageStep && uploadStep > attestStep)
  const installerSteps = runtimeImage.slice(packageStep, uploadStep)
  assert.match(installerSteps, /--publication runtime-image-publication\.json/)
  assert.match(installerSteps, /--sbom "\$\{\{ steps\.coordinates\.outputs\.sbom_name \}\}"/)
  assert.match(installerSteps, /subject-path: mentra-private-cloud\.tar\.gz/)
  assert.equal((installerSteps.match(/if: inputs\.dry_run != true/g) || []).length, 2)

  assert.match(privateDeploymentJob, /^    needs: \[plan, runtime-image\]$/m)
  // Dev always deploys demo-dev; only the staging sales demo can be frozen.
  assert.match(
    privateDeploymentJob,
    /needs\.plan\.outputs\.cloud_environment == 'dev' \|\|\n      \(needs\.plan\.outputs\.cloud_environment == 'staging' && vars\.ENTERPRISE_DEMO_FROZEN != 'true'\)/,
  )
  assert.match(privateDeploymentJob, /uses: \.\/\.github\/workflows\/private-deployment\.yml/)
  // Admin keys come from each stack's Key Vault, not repository secrets.
  assert.doesNotMatch(privateDeploymentJob, /secrets:/)
  assert.doesNotMatch(privateDeployment, /\$\{\{ secrets\.|^\s+secrets:/m)
  assert.match(privateDeployment, /az keyvault secret show --vault-name "\$AZURE_KEY_VAULT" --name mentra-admin-key/)
  assert.match(privateDeployment, /echo "::add-mask::\$admin_token"/)
  assert.match(privateDeploymentJob, /source_commit: \$\{\{ needs\.plan\.outputs\.source_commit \}\}/)
  assert.match(privateDeploymentJob, /release_plan_artifact: \$\{\{ needs\.plan\.outputs\.plan_artifact \}\}/)
  assert.match(
    privateDeploymentJob,
    /runtime_image_artifact: \$\{\{ needs\.runtime-image\.outputs\.result_artifact \}\}/,
  )
  assert.match(privateDeployment, /workflow_call:/)
  assert.doesNotMatch(privateDeployment, /push:/)
  assert.doesNotMatch(privateDeployment, /workflow_dispatch:/)
  assert.match(privateDeployment, /group: coordinated-private-deployment-\$\{\{ github\.ref_name \}\}/)
  assert.match(privateDeployment, /\[\[ "\$source_commit" == "\$\{\{ inputs\.source_commit \}\}" \]\]/)
  assert.match(privateDeployment, /coordinated-private-deployment-records\.mjs create/)
  assert.match(privateDeployment, /az acr import/)
  assert.doesNotMatch(privateDeployment, /az acr build/)
  assert.match(privateDeployment, /ghcr\.io\/mentra-community\/mentra-cloud/)
  assert.match(privateDeployment, /coreApiClientId:\{value:\$coreApiClientId\}/)
  // Signing keys stay in the stack's Key Vault; the workflow passes only its name.
  assert.match(privateDeployment, /keyVaultName:\{value:\$keyVaultName\}/)
  assert.doesNotMatch(privateDeployment, /MENTRA_JWT_PRIVATE_KEY|REFRESH_TOKEN_PEPPER|TEAMS_GRAPH_CLIENT_SECRET|manageAcrPullRoleAssignment/)
  assert.match(privateDeployment, /source_digest.*image_digest|image_digest.*source_digest/s)
  // The plan's channel selects the stack; its names match the release records.
  const stacks = privateDeployment.split("- name: Select the release channel's demo stack\n")[1]
    .split("      - name: Resolve and verify exact source\n")[0]
  const deployers = {dev: "DEMO_DEV_AZURE_CLIENT_ID", beta: "DEMO_AZURE_CLIENT_ID"}
  assert.deepEqual(Object.keys(PRIVATE_DEPLOYMENT_TARGETS).sort(), Object.keys(deployers).sort())
  for (const [channel, target] of Object.entries(PRIVATE_DEPLOYMENT_TARGETS)) {
    const stack = stacks.split(`            ${channel})\n`)[1].split("              ;;\n")[0]
    assert.ok(stack.includes(`azure_client_id="$${deployers[channel]}"`), `${channel} deployer`)
    for (const [variable, value] of [["AZURE_RESOURCE_GROUP", target.resourceGroup], ["AZURE_REGISTRY", target.registry],
      ["AZURE_CONTAINER_APP", target.containerApp], ["AZURE_CORE_CONTAINER_APP", target.coreContainerApp],
      ["WORKSPACE_HOSTNAME", new URL(target.workspaceOrigin).hostname]]) {
      assert.match(stack, new RegExp(`^          ${variable}=${value.replaceAll(".", "\\.")}$`, "m"), `${channel} ${variable}`)
    }
  }
  assert.match(privateDeployment, /client-id: \$\{\{ env\.AZURE_CLIENT_ID \}\}/)
  assert.match(privateDeployment, /--arg workspaceHostname "\$WORKSPACE_HOSTNAME"/)
  assert.match(privateDeployment, /workspaceCertificateName:\{value:\$workspaceCertificateName\}/)
  // The sales demo keeps its earlier addresses bound for phones that enrolled with them.
  assert.match(stacks, /^          WORKSPACE_ALIASES=\[\{"hostname":"mentra\.acmeworkspace\.com","certificateName":"ca-mentra-enterprise-reference-acme-workspace"\},\{"hostname":"enterprisedev\.mentraglass\.com","certificateName":"ca-mentra-enterprise-reference-workspace"\}\]$/m)
  assert.match(stacks, /^          WORKSPACE_ALIASES=\[\]$/m)
  assert.match(privateDeployment, /additionalWorkspaceDomains:\{value:\$additionalWorkspaceDomains\}/)
  // Each Runtime serves its managed bundles on its own origin.
  assert.match(privateDeployment, /bundlePath:\(\.bundleUrl \| sub\("\^https:\/\/\[\^\/\]\+"; ""\)\)/)
  // Azure issues a managed certificate only for a hostname already on an app.
  const attachHostname = privateDeployment.indexOf("az containerapp hostname add")
  assert.ok(attachHostname >= 0)
  assert.ok(attachHostname < privateDeployment.indexOf("az deployment group create"))
  assert.match(privateDeployment, /displayName:\{value:\$displayName\}/)
  assert.match(privateDeployment, /and \.deploymentId == \$deploymentId/)
  assert.match(privateDeployment, /az acr manifest show-metadata/)
  assert.match(privateDeployment, /latestReadyRevisionName/)
  assert.doesNotMatch(finalize, /private-deployment|privateDeployment/)
  assert.match(finalize, /needs\.runtime-image\.result == 'success'/)
  assert.match(finalize, /--runtime-image release-input\/runtime-image\/runtime-image-publication\.json/)
  assert.match(notify, /PRIVATE_DEPLOYMENT_RESULT: \$\{\{ needs\.private-deployment\.result \}\}/)
  assert.match(notify, /RUNTIME_IMAGE_RESULT: \$\{\{ needs\.runtime-image\.result \}\}/)

  // Customers' stable install URL follows only verified, deployed releases.
  const channel = jobBlock(coordinator, "private-cloud-channel")
  assert.match(channel, /^    needs: \[plan, runtime-image, private-deployment\]$/m)
  assert.match(channel, /needs\.runtime-image\.result == 'success'/)
  // Every coordinated channel has a stack, so a frozen stack holds its channel.
  assert.match(channel, /needs\.private-deployment\.result == 'success'\n/)
  assert.doesNotMatch(channel, /'skipped'/)
  assert.match(channel, /needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(channel, /cancel-in-progress: false/)
  assert.ok(channel.indexOf("gh attestation verify") < channel.indexOf("publish-private-cloud-channel.mjs"))
  assert.match(channel, /--bootstrap cloud-v2\/deploy\/azure\/enterprise-reference\/installer\/bootstrap\.sh/)
  assert.doesNotMatch(finalize, /private-cloud-channel/)
})

for (const [stuckApp, sameImage, diagnosticsUnavailable, startupLog = "private-token-must-not-print"] of [["", false], ["runtime", false], ["core", false], ["", true], ["core", false, true],
  ["core", false, false, "private-token-must-not-print MongoServerError unsupported index option partialFilterExpression"],
  ["core", false, false, "private-token-must-not-print aggregation pipeline is not supported"],
  ["core", false, false, "private-token-must-not-print authorization failed OOMKilled"]]) {
  test(`private deployment waits for both release images before HTTP probes (${diagnosticsUnavailable ? "diagnostics unavailable" : stuckApp || (sameImage ? "configuration-only rollout" : "successful rollout")}; ${startupLog})`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "private-rollout-"))
    const digest = `sha256:${"a".repeat(64)}`
    const image = `registry.example/cloud@${digest}`
    // Execute the real verification step through its HTTP health probes. Azure
    // initially reports healthy previous revisions; each target becomes ready
    // on the second poll unless the scenario leaves that service stuck.
    const step = workflow("private-deployment.yml")
      .split("      - name: Verify the live enterprise contract\n")[1]
      .split("        run: |\n")[1]
      .split("          jq -e '.status")[0]
      .replace(/^          /gm, "")
      .replace("source .github/scripts/azure-readiness-diagnostics.sh", readFileSync(new URL("./azure-readiness-diagnostics.sh", import.meta.url), "utf8").split('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then')[0])
      .replace(/\$\{\{ steps\.source\.outputs\.(\w+) \}\}/g, (_, key) => ({
        acr_tag: "release-tag", source_digest: digest, image,
      })[key])
    const mocks = `
      az() {
        case "$*" in
          "containerapp logs show"*)
            if [[ "$DIAGNOSTICS_UNAVAILABLE" == true ]]; then
              echo private-token-must-not-print >&2; return 1
            fi
            [[ "$*" == *"--revision $STUCK_APP-new "* ]] || return 1
            echo "$STARTUP_LOG"
            ;;
          *latestRevision:properties.latestRevisionName*)
            if [[ "$DIAGNOSTICS_UNAVAILABLE" == true ]]; then
              echo private-token-must-not-print >&2; return 1
            fi
            printf '{"latestRevision":"%s-new","latestReadyRevision":"%s-old","provisioningState":"Succeeded","secrets":[{"value":"private-token-must-not-print"}]}' "$STUCK_APP" "$STUCK_APP"
            ;;
          *provisioningState:properties.provisioningState*)
            if [[ "$DIAGNOSTICS_UNAVAILABLE" == true ]]; then
              echo private-token-must-not-print >&2; return 1
            fi
            local revision="$STUCK_APP-new" image="$TARGET_IMAGE"
            [[ "$*" != *"--revision $STUCK_APP-old "* ]] || { revision="$STUCK_APP-old"; image=registry.example/cloud:previous; }
            printf '{"name":"%s","active":true,"provisioningState":"Succeeded","healthState":"Unhealthy","runningState":"Failed","images":["%s"],"provisioningError":"private-token-must-not-print","template":{"env":[{"value":"private-token-must-not-print"}]}}' "$revision" "$image"
            ;;
          "containerapp replica list"*)
            if [[ "$DIAGNOSTICS_UNAVAILABLE" == true ]]; then
              echo private-token-must-not-print >&2; return 1
            fi
            echo '[{"name":"replica-one","containers":[{"name":"core","ready":false,"restartCount":3,"runningState":{"state":"Terminated","detail":"private-token-must-not-print"},"console":"private-token-must-not-print"}],"logs":"private-token-must-not-print"}]'
            ;;
          *properties.outputs.workspaceOrigin.value*) echo https://workspace.example ;;
          *properties.outputs.coreOrigin.value*) echo https://core.example.azurecontainerapps.io ;;
          *properties.outputs.generatedCoreHostname.value*) echo core.example.azurecontainerapps.io ;;
          "acr manifest show-metadata"*) echo "$TARGET_DIGEST" ;;
          "containerapp show"*)
            local app=core count=0
            [[ "$*" != *"--name runtime "* ]] || app=runtime
            if [[ "$*" == *properties.latestRevisionName* ]]; then
              echo "$app-new"
              return 0
            fi
            [[ ! -f "$app-count" ]] || read -r count < "$app-count"
            count=$((count + 1))
            echo "$count" > "$app-count"
            if [[ "$count" -ge 2 && "$STUCK_APP" != "$app" ]]; then
              echo "$app-new"
            else
              echo "$app-old"
            fi
            ;;
          "containerapp revision show"*)
            if [[ "$*" == *"--revision runtime-new "* ]]; then
              touch runtime-ready; echo "$TARGET_IMAGE"
            elif [[ "$*" == *"--revision core-new "* ]]; then
              touch core-ready; echo "$TARGET_IMAGE"
            elif [[ "$SAME_IMAGE" == true ]]; then
              echo "$TARGET_IMAGE"
            else
              echo registry.example/cloud:previous
            fi
            ;;
          *) echo "Unexpected Azure command: $*" >&2; return 1 ;;
        esac
      }
      timeout() { [[ "$1" == 8s ]] || return 1; shift; "$@"; }
      sleep() { :; }
      curl() {
        echo probe >> probes
        if [[ ! -f runtime-ready || ! -f core-ready ]]; then
          echo "HTTP would read a previous release's manifest" >&2
          return 1
        fi
        echo 200
      }
    `
    try {
      const result = spawnSync("bash", ["-c", `${mocks}\n${step}`], {
        cwd: directory,
        env: {...process.env, AZURE_RESOURCE_GROUP: "group", AZURE_REGISTRY: "registry",
          AZURE_CONTAINER_APP: "runtime", AZURE_CORE_CONTAINER_APP: "core", RUNNER_TEMP: directory,
          TARGET_DIGEST: digest, TARGET_IMAGE: image, STUCK_APP: stuckApp, SAME_IMAGE: String(sameImage),
          DIAGNOSTICS_UNAVAILABLE: String(!!diagnosticsUnavailable), STARTUP_LOG: startupLog},
        encoding: "utf8", timeout: 10_000,
      })
      assert.ifError(result.error)
      if (stuckApp) {
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /has no ready revision running/)
        assert.equal(existsSync(path.join(directory, "probes")), false)
        assert.equal(readFileSync(path.join(directory, `${stuckApp}-count`), "utf8").trim(), "30")
        assert.doesNotMatch(result.stderr + result.stdout, /private-token-must-not-print/)
        if (diagnosticsUnavailable) {
          assert.match(result.stderr, /metadata unavailable/)
          assert.match(result.stderr, /Azure startup hint: sample-unavailable/)
        } else {
          assert.ok(result.stderr.includes(`"latestRevision":"${stuckApp}-new"`))
          assert.ok(result.stderr.includes(`"latestReadyRevision":"${stuckApp}-old"`))
          assert.ok(result.stderr.includes(`"images":["${image}"]`))
          assert.match(result.stderr, /"images":\["registry\.example\/cloud:previous"\]/)
          assert.match(result.stderr, /"ready":false,"restartCount":3,"runningState":"Terminated"/)
          const codes = [
            [/partialFilterExpression/, "mongo-index-option-unsupported"], [/pipeline/, "mongo-pipeline-unsupported"],
            [/MongoServerError/, "mongo-server-error"], [/authorization failed/, "authorization-failed"], [/OOMKilled/, "out-of-memory"],
          ].filter(([pattern]) => pattern.test(startupLog)).map(([, code]) => code)
          for (const code of codes.length ? codes : ["unknown"]) assert.ok(result.stderr.includes(`Azure startup hint: ${code}`))
        }
        assert.equal(readdirSync(directory).some(name => name.startsWith("azure-startup-log.")), false)
      } else {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(readFileSync(path.join(directory, "probes"), "utf8").trim().split("\n").length, 4)
        assert.equal(readFileSync(path.join(directory, "runtime-count"), "utf8").trim(), "2")
        assert.equal(readFileSync(path.join(directory, "core-count"), "utf8").trim(), "2")
      }
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  })
}

test("mobile destinations use real TestFlight groups without changing the release channel", () => {
  const coordinator = workflow("coordinated-release.yml")
  const mobile = workflow("reusable-coordinated-mobile.yml")
  const example = workflow("reusable-coordinated-example-testflight.yml")
  const mobileIos = jobBlock(mobile, "ios")
  const mobileStore = jobBlock(mobile, "ios-store")
  const exampleIos = jobBlock(example, "ios")
  const exampleStore = jobBlock(example, "testflight")

  // Dev releases (TestFlight group Mentra Dev) come from the Mentra monorepo.
  assert.doesNotMatch(coordinator, /testflight_group=Mentra Dev/)
  assert.match(coordinator, /testflight_group=Mentra Staging/)
  assert.match(mobile, /MENTRA_COORDINATED_RELEASE_CHANNEL=\$\(jq -er \.channel release-intent\/release-plan\.json\)/)
  assert.doesNotMatch(mobile, /compatibility_lab|testFlightInternalTestingOnly/)
  assert.match(mobile, /google-play-internal-sharing\.mjs/)
  assert.match(mobile, /if: inputs\.dry_run != true && inputs\.play_track == 'internal-app-sharing'/)
  assert.match(mobile, /--internal-sharing mobile-release\/android-internal-sharing\.json/)
  assert.match(mobile, /play_install_url:\n        value: \$\{\{ jobs\.android\.outputs\.play_install_url \}\}/)
  assert.match(coordinator, /PLAY_INSTALL_URL: \$\{\{ needs\.mobile\.outputs\.play_install_url \}\}/)
  // The beta channel and the plan's expected coordinate name the same Play destination.
  assert.match(coordinator, /play_track=beta/)
  // The Android build resolves its own version code before building and the
  // record carries it; verification and the track check use the same value.
  assert.match(mobile, /- name: Resolve and reserve the Android version code\n        id: android-code/)
  assert.match(mobile, /resolve-android-version-code\.mjs/)
  assert.match(
    mobile,
    /--assets android-code-registry-assets\.json --owner "\$OWNER" --marker-dir android-version-code-marker/,
  )
  assert.match(mobile, /RESERVATION_RELEASE_TAG: mentra-coordinated-asg/)
  assert.match(
    mobile,
    /RESERVE: \$\{\{ inputs\.dry_run != true && needs\.prepare\.outputs\.android_assets_exist != 'true'/,
  )
  const reservation = mobile.slice(
    mobile.indexOf("- name: Resolve and reserve the Android version code"),
    mobile.indexOf("- name: Build signed coordinated APK and AAB"),
  )
  assert.match(reservation, /ARTIFACTS_R2_ACCESS_KEY_ID: \$\{\{ secrets\.ARTIFACTS_R2_ACCESS_KEY_ID \}\}/)
  assert.match(reservation, /"\$tooling\/resolve-android-version-code\.mjs"/)
  assert.match(reservation, /bundle exec fastlane used_version_codes/)
  assert.match(reservation, /--used "\$GOOGLE_PLAY_USED_VERSION_CODES_OUTPUT"/)
  assert.match(mobileFastfile("fastlane-android"), /lane :used_version_codes do/)
  assert.match(reservation, /"\$tooling\/publish-immutable-release-asset\.mjs"/)
  assert.doesNotMatch(reservation, /node \.github\/scripts\//)
  assert.match(mobile, /but this release has no immutable Android pair; refusing to treat it as reused/)
  assert.match(coordinator, /--play-track "\$\{\{ steps\.channel\.outputs\.play_track \}\}"/)
  assert.match(mobile, /EXPECTED_BUILD: \$\{\{ steps\.android-code\.outputs\.code \}\}/)
  assert.match(mobile, /--android-build-number "\$\{\{ steps\.android-code\.outputs\.code \}\}"/)
  assert.ok(
    mobile.indexOf("- name: Resolve and reserve the Android version code") <
      mobile.indexOf("- name: Build signed coordinated APK and AAB"),
  )
  assert.ok(
    mobile.indexOf("- name: Install Google Play upload tooling") <
      mobile.indexOf("- name: Resolve and reserve the Android version code"),
  )
  assert.match(mobile, /url="https:\/\/play\.google\.com\/apps\/testing\/com\.mentra\.mentra"/)
  assert.match(
    readFileSync(new URL("./release-family.mjs", import.meta.url), "utf8"),
    /DEFAULT_PLAY_TRACKS = Object\.freeze\(\{dev: "internal", beta: "beta", production: "production"\}\)/,
  )
  assert.doesNotMatch(mobile, /MENTRA_COORDINATED_RELEASE_CHANNEL=\$\{\{ inputs\.testflight_group \}\}/)
  assert.match(example, /EXAMPLE_APP_ID: "6792839366"/)
  assert.match(example, /EXAMPLE_BUNDLE_ID: com\.mentra\.bluetoothsdkexample/)
  assert.match(example, /config\.expo\.ios\.bundleIdentifier = process\.env\.EXAMPLE_BUNDLE_ID/)
  // Production uploads to the same App Store app, so its identifier is stamped
  // for every channel, never assumed from the example's committed one.
  assert.doesNotMatch(example, /MENTRA_CHANNEL !== "production"/)
  assert.match(example, /find ios -maxdepth 1 -name '\*\.xcworkspace'/)
  assert.match(example, /select\(\. == "MentraBluetoothExample"\)/)
  assert.match(example, /security list-keychains -d user -s "\$keychain"/)
  assert.match(example, /certificate_id=\$\(basename "\$certificate" \.cer\)/)
  assert.match(example, /awk -v fingerprint="\$certificate_fingerprint" '\$2 == fingerprint/)
  assert.match(example, /bundle exec fastlane sigh/)
  assert.match(example, /--app_identifier "\$EXAMPLE_BUNDLE_ID"/)
  assert.match(example, /--cert_id "\$certificate_id"/)
  assert.match(example, /configure-example-ios-signing\.rb/)
  assert.doesNotMatch(example, /PROVISIONING_PROFILE_SPECIFIER=/)
  assert.doesNotMatch(example, /CODE_SIGN_STYLE=Manual/)
  assert.match(example, /OTHER_CODE_SIGN_FLAGS="--keychain \$MENTRA_CI_KEYCHAIN"/)
  assert.match(example, /provisioningProfiles: \{\(\$bundle_id\): \$profile\}/)
  assert.match(example, /PlistBuddy -c 'Print :com\.apple\.developer\.networking\.HotspotConfiguration'/)
  assert.equal([...example.matchAll(/--app-id "\$EXAMPLE_APP_ID"/g)].length, 5)
  assert.match(example, /\[\[ "\$\(git rev-parse HEAD\)" == "\$\{\{ inputs\.source_commit \}\}" \]\]/)
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
  assert.match(mobileStore, /^    runs-on: blacksmith-\d+vcpu-ubuntu-2404$/m)
  assert.match(mobileStore, /app-store-connect-build\.mjs assign/)
  assert.doesNotMatch(exampleIos, /app-store-connect-build\.mjs assign/)
  assert.match(exampleStore, /^    runs-on: blacksmith-\d+vcpu-ubuntu-2404$/m)
  assert.match(exampleStore, /app-store-connect-build\.mjs assign/)
  assert.match(exampleStore, /--review-notes ""/)
})

test("coordinated docs publish only after finalization to the matching channel", () => {
  const coordinator = workflow("coordinated-release.yml")
  const plan = jobBlock(coordinator, "plan")
  // Store build numbers come from the family formula with the run number as
  // the sequence, for the app plan and the ASG client alike.
  assert.match(plan, /allocate-family-build-sequence\.mjs allocate/)
  assert.match(plan, /--owner "coordinated-run:\$\{GITHUB_RUN_ID\}"/)
  assert.match(plan, /mkdir -p family-build-number-markers/)
  assert.match(plan, /release-assets\.mjs fetch \\\n[\s\S]{0,180}--asset-id "\$asset_id"/)
  assert.match(plan, /--markers-dir family-build-number-markers/)
  assert.match(plan, /--native-build-number "\$\{\{ steps\.family-number\.outputs\.build_number \}\}"/)
  assert.match(plan, /Record the family build number in the release container/)
  assert.doesNotMatch(coordinator, /310000000|--native-build-sequence/)
  const familyChecks = workflow("release-family-checks.yml")
  assert.match(familyChecks, /--native-build-sequence 1 \\/)
  assert.doesNotMatch(familyChecks, /310000001|--native-build-number/)
  assert.match(
    workflow("reusable-coordinated-ota.yml"),
    /allocate-asg-version\.mjs \\\n[\s\S]{0,300}--build-number "\$\(jq -er \.native\.buildNumber release-intent\/release-plan\.json\)"/,
  )
  const examples = jobBlock(coordinator, "examples")
  const engineConsumer = jobBlock(coordinator, "engine-consumer")
  const exampleTestflight = jobBlock(coordinator, "example-testflight")
  const exampleGooglePlay = jobBlock(coordinator, "example-google-play")
  const docs = jobBlock(coordinator, "docs")
  const notify = jobBlock(coordinator, "notify-slack")
  const finalize = jobBlock(coordinator, "finalize")

  // The Mentra beta (Cloud V2, the Mentra App, Engine, Bluetooth SDK) is
  // complete on its own; the Bluetooth examples build from the same source in
  // the same run and are finalized as a separate record, so they can never
  // make the beta incomplete.
  assert.match(
    finalize,
    /^    needs: \[plan, cloud-v2, runtime-image, ota, npm, sdk-native, mobile, engine-consumer\]$/m,
  )
  assert.doesNotMatch(finalize.split("\n    runs-on:")[0], /examples|example-testflight|example-google-play/)
  assert.match(engineConsumer, /^    needs: \[plan, npm\]$/m)
  // The examples build from source in parallel with the packages and apps,
  // stamped with the release's OTA pin, and upload their own files.
  assert.match(examples, /^    needs: \[plan, ota\]$/m)
  assert.match(examples, /uses: \.\/\.github\/workflows\/reusable-bluetooth-examples\.yml/)
  assert.match(examples, /ota_manifest_sha256: \$\{\{ needs\.ota\.outputs\.manifest_sha256 \}\}/)
  assert.match(examples, /if: needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(examples, /release_id: \$\{\{ needs\.plan\.outputs\.release_id \}\}/)
  assert.match(examples, /secrets: inherit/)
  assert.match(exampleTestflight, /^    needs: \[plan, ota, finalize\]$/m)
  assert.match(exampleGooglePlay, /^    needs: \[plan, ota, finalize\]$/m)
  for (const job of ["publish-examples", "finalize-example", "export-starter-kit", "notify-slack-examples"]) {
    assert.doesNotMatch(coordinator, new RegExp(`^  ${job}:$`, "m"), job)
  }
  // No cross-repository machinery remains.
  for (const name of ["coordinated-example-release.yml", "reusable-coordinated-starter-kit.yml"]) {
    assert.equal(existsSync(new URL(`../workflows/${name}`, import.meta.url)), false, name)
  }
  assert.equal(existsSync(new URL("load-coordinated-example-release.mjs", import.meta.url)), false)
  assert.doesNotMatch(coordinator, /dispatch-examples|gh workflow run|STARTER_KIT_COORDINATOR_TOKEN|Starter-Kit-Source/)
  // The Starter Kit export is scheduled, never called from the release.
  assert.doesNotMatch(coordinator, /bluetooth-starter-kit-export|example-release-records/)
  assert.match(plan, /Restore the release plan selected by an earlier attempt/)
  assert.match(plan, /actions\/runs\/\$GITHUB_RUN_ID\/artifacts/)
  assert.match(plan, /gh run download "\$GITHUB_RUN_ID"/)
  assert.match(plan, /output=release-plan\.verify\.json/)
  assert.match(plan, /cmp release-plan\.json "\$output"/)
  assert.equal([...plan.matchAll(/if: steps\.restore-plan\.outputs\.restored != 'true'/g)].length, 1)
  assert.doesNotMatch(plan, /source_timestamp/)
  assert.match(exampleTestflight, /reusable-coordinated-example-testflight\.yml/)
  assert.match(finalize, /needs\.engine-consumer\.result == 'success'/)
  assert.match(docs, /^    needs: \[plan, examples, example-testflight\]$/m)
  assert.doesNotMatch(docs, /needs\.(finalize-example|example-google-play)/)
  assert.match(docs, /EXAMPLE_APK_URL: \$\{\{ needs\.examples\.outputs\.react_native_url \}\}/)
  assert.match(docs, /project=mentraos-docs-dev/)
  assert.match(docs, /docs_url=https:\/\/docs-dev\.mentraglass\.com/)
  assert.match(docs, /project=mentraos-docs-beta/)
  assert.match(docs, /docs_url=https:\/\/docs-beta\.mentraglass\.com/)
  assert.match(docs, /render-coordinated-docs\.mjs/)
  assert.match(docs, /--example-apk-url "\$\{\{ needs\.examples\.outputs\.react_native_url \}\}"/)
  assert.match(docs, /--example-testflight/)
  assert.match(docs, /Cache-Control: public, max-age=0, must-revalidate/)
  assert.match(docs, /X-Robots-Tag: noindex/)
  const purge = docs.slice(
    docs.indexOf("- name: Purge release-sensitive"),
    docs.indexOf("- name: Verify the published custom domain"),
  )
  const verify = docs.slice(docs.indexOf("- name: Verify the published custom domain"))
  assert.match(purge, /continue-on-error: true/)
  assert.match(purge, /timeout-minutes: 1/)
  assert.doesNotMatch(verify, /continue-on-error: true/)
  assert.match(verify, /exit 1/)
  assert.match(docs, /CLOUDFLARE_ZONE_ID: \$\{\{ vars\.CLOUDFLARE_ZONE_ID \}\}/)
  assert.match(docs, /zones\/\$CLOUDFLARE_ZONE_ID\/purge_cache/)
  assert.match(docs, /\$DOCS_URL\/mentra-live\/software-update\//)
  assert.match(docs, /grep --fixed-strings --quiet "\$RELEASE_IDENTITY" "\$body"/)
  assert.match(docs, /grep --fixed-strings --quiet "href=\\"\$EXAMPLE_APK_URL\\"" "\$body"/)
  assert.match(docs, /grep --fixed-strings --quiet "href=\\"\$EXAMPLE_IOS_URL\\"" "\$body"/)
  assert.match(docs, /%7b%7b\[a-z0-9_-\]\+%7d%7d/)
  assert.match(notify, /EXAMPLES_RESULT: \$\{\{ needs\.examples\.result \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_RESULT: \$\{\{ needs\.example-testflight\.result \}\}/)
  assert.match(notify, /EXAMPLE_TESTFLIGHT_INSTALL_URL: \$\{\{ needs\.example-testflight\.outputs\.install_url \}\}/)
  assert.doesNotMatch(notify, /EXAMPLE_TESTFLIGHT_(BUILD_NUMBER|MARKETING_VERSION|REVIEW_STATE|DISTRIBUTION_STATUS)/)
  assert.match(notify, /EXAMPLE_GOOGLE_PLAY_RESULT: \$\{\{ needs\.example-google-play\.result \}\}/)
  assert.match(notify, /EXAMPLE_GOOGLE_PLAY_INSTALL_URL: \$\{\{ needs\.example-google-play\.outputs\.install_url \}\}/)
  assert.match(notify, /DOCS_RESULT: \$\{\{ needs\.docs\.result \}\}/)
  // The store builds are the example at the release source, stamped like the
  // Mentra App; no Starter Kit checkout or token remains.
  for (const name of ["reusable-coordinated-example-testflight.yml", "reusable-coordinated-example-google-play.yml"]) {
    const store = workflow(name)
    assert.doesNotMatch(store, /create-github-app-token|STARTER_KIT|starter-kit|starter_kit/, name)
    assert.match(store, /working-directory: examples\/bluetooth\/react-native/, name)
    assert.match(store, /uses: \.\/release-tooling\/\.github\/actions\/stamp-release/, name)
  }
  assert.doesNotMatch(workflow("reusable-coordinated-example-testflight.yml"), /group: mentra-ios-signing-runner/)
})

test("the release's example builds are stamped with the same release metadata as the Mentra App", () => {
  const reusable = workflow("reusable-bluetooth-examples.yml")
  const action = readFileSync(new URL("../actions/stamp-release/action.yml", import.meta.url), "utf8")
  assert.match(action, /node \.github\/scripts\/stage-release-family\.mjs --plan "\$PLAN"/)
  assert.match(action, /node mobile\/modules\/bluetooth-sdk\/scripts\/write-release-metadata\.mjs "\$\{metadata\[@\]\}"/)
  assert.match(action, /node mobile\/modules\/engine\/scripts\/write-release-metadata\.mjs "\$\{metadata\[@\]\}"/)
  assert.match(action, /--ota-manifest-sha256 "\$OTA_MANIFEST_SHA256"/)
  // One stamping implementation, used by every release example build.
  let uses = 0
  for (const name of readdirSync(new URL("../workflows/", import.meta.url)).filter((file) => file.endsWith(".yml"))) {
    const source = workflow(name)
    uses += [...source.matchAll(/uses: \.\/release-tooling\/\.github\/actions\/stamp-release/g)].length
  }
  assert.equal(uses, 6)
  for (const job of ["android", "react-native", "react-native-elevenlabs-audio", "ios"]) {
    const block = jobBlock(reusable, job)
    assert.match(block, /uses: \.\/release-tooling\/\.github\/actions\/stamp-release/, job)
    assert.match(block, /ota-manifest-sha256: \$\{\{ inputs\.ota_manifest_sha256 \}\}/, job)
  }
  // The React Native examples are stamped after the workspace install, as the app is.
  const reactNative = jobBlock(reusable, "react-native")
  assert.ok(reactNative.indexOf("bun install --frozen-lockfile") < reactNative.indexOf("Stamp the release"))
  // The examples upload their own files, by deterministic names.
  const publish = jobBlock(reusable, "publish")
  assert.match(publish, /needs: \[prepare, android, react-native, react-native-elevenlabs-audio, ios\]/)
  assert.match(publish, /bluetooth-example-artifacts\.mjs names --plan "\$plan"/)
  assert.match(publish, /publish-immutable-release-asset\.mjs/)
  assert.match(publish, /ARTIFACTS_R2_SECRET_ACCESS_KEY: \$\{\{ secrets\.ARTIFACTS_R2_SECRET_ACCESS_KEY \}\}/)
  // Pull requests run the same jobs without a release.
  assert.match(workflow("example-app-builds.yml"), /uses: \.\/\.github\/workflows\/reusable-bluetooth-examples\.yml/)
})

test("example builds outside releases compile one architecture and reuse caches", () => {
  const reusable = workflow("reusable-bluetooth-examples.yml")
  assert.doesNotMatch(reusable, /cache: gradle/)
  for (const job of ["android", "react-native", "react-native-elevenlabs-audio"]) {
    const block = jobBlock(reusable, job)
    assert.match(block, /key: gradle-v2-\$\{\{ runner\.environment \}\}-\$\{\{ runner\.os \}\}-example-[a-z-]+-\$\{\{ steps\.cache-week\.outputs\.week \}\}-/, job)
    // Gradle's local build cache lives in the cached ~/.gradle/caches.
    assert.match(block, /\.\/gradlew :app:assemble(Debug|Release) --no-daemon --build-cache/, job)
  }
  for (const job of ["react-native", "react-native-elevenlabs-audio"]) {
    const block = jobBlock(reusable, job)
    assert.match(block, /key: bun-\$\{\{ runner\.environment \}\}-\$\{\{ runner\.os \}\}-examples-\$\{\{ hashFiles\('examples\/bun\.lock'\) \}\}/, job)
    assert.ok(block.indexOf("Cache Bun dependencies") < block.indexOf("bun install --frozen-lockfile"), job)
    // Releases ship every ABI; everything else builds arm64-v8a only.
    assert.match(
      block,
      /if: needs\.prepare\.outputs\.release != 'true'\n\s+run: echo "ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a" >> "\$GITHUB_ENV"/,
      job,
    )
    assert.ok(block.indexOf("ORG_GRADLE_PROJECT_reactNativeArchitectures") < block.indexOf("Build release Android app"), job)
  }
  assert.match(
    jobBlock(reusable, "react-native-macos"),
    /ONLY_ACTIVE_ARCH: \$\{\{ needs\.prepare\.outputs\.release == 'true' && 'NO' \|\| 'YES' \}\}/,
  )
})

test("the Starter Kit export is scheduled, stops cheaply, and pushes only to the kit", () => {
  const exporter = workflow("bluetooth-starter-kit-export.yml")
  assert.doesNotMatch(exporter, /workflow_call:|--timeout-minutes|missingPublications/)
  assert.match(exporter, /schedule:\n    - cron: "7,37 \* \* \* \*"/)
  assert.match(exporter, /workflow_dispatch:\n    inputs:\n      dry_run:/)
  // The export always means each channel's latest completed release.
  assert.doesNotMatch(exporter, /inputs\.identity|^      identity:/m)
  assert.match(exporter, /channel: \[dev, beta, production\]/)
  assert.match(exporter, /group: starter-kit-export-\$\{\{ matrix\.channel \}\}/)
  assert.match(exporter, /cancel-in-progress: false/)
  assert.match(exporter, /runs-on: blacksmith-2vcpu-ubuntu-2404/)
  // The first step needs no checkout, Node or clone.
  const steps = exporter.split("\n    steps:\n")[1]
  const first = steps.split(/\n      - /)[1]
  assert.match(first, /^name: Check whether the kit needs a release/)
  assert.doesNotMatch(first, /actions\/checkout|setup-node|git clone|node /)
  assert.match(first, /gh api "repos\/\$STARTER_KIT_REPOSITORY\/contents\/starter-kit-release\.json\?ref=\$branch"/)
  assert.ok(steps.indexOf("Check whether the kit needs a release") < steps.indexOf("actions/checkout@v4"))
  assert.match(exporter, /export-bluetooth-starter-kit\.mjs transform/)
  assert.match(exporter, /repositories: Mentra-Bluetooth-SDK-Starter-Kit\n/)
  assert.match(exporter, /permission-contents: write/)
  // The export carries the kit's CI (examples/bluetooth/.github) and replaces the kit's.
  assert.match(exporter, /permission-workflows: write/)
  assert.doesNotMatch(exporter, /permission-actions|--force|push -f/)
  assert.match(exporter, /find kit -mindepth 1 -maxdepth 1 ! -name \.git -exec rm -rf \{\} \+/)
  // Branch and tag land together and failures are explicit.
  assert.match(exporter, /git -C kit push --quiet --atomic "\$remote" "HEAD:refs\/heads\/\$BRANCH" "\$tag" \|\| push_status=\$\?/)
  assert.match(exporter, /Could not push \$IDENTITY to \$BRANCH\.[^\n]*\n\s+exit 1/)
})

test("release-family promotion advances MentraOS only; the Starter Kit is exported per release", () => {
  const script = repositoryScript("promote-release-family.mjs")
  const start = script.indexOf('if (command === "start")')
  const mentraosPromotion = script.indexOf("repository: MENTRAOS_REPOSITORY", start)
  const finish = script.indexOf("requireSuccessfulBetaRun(options.run)", mentraosPromotion)
  const preparation = script.indexOf("scripts/prepare-next-release-family.mjs", finish)

  assert.ok(start >= 0)
  assert.ok(mentraosPromotion > start)
  assert.ok(finish > mentraosPromotion)
  assert.ok(preparation > finish)
  assert.doesNotMatch(script, /STARTER_KIT_REPOSITORY|Starter-Kit-Source|starterKitStagingHead/)
  assert.match(script, /--match-head-commit", promotionHead/)
  assert.match(script, /run\.path !== "\.github\/workflows\/coordinated-release\.yml"/)
  assert.match(script, /run\.head_sha !== stagingHead/)
  assert.match(script, /expectedIdentity = `\$\{plan\.familyBaseVersion\}-beta\.\$\{run\.run_number\}`/)
  assert.match(script, /plan\.sourceCommit !== stagingHead/)
  assert.match(script, /createMetadataCommit\(repository, targetHead, family, mergeBody\)/)
  assert.match(script, /release\/promote-\$\{family\}-refresh-pin-\$\{marker\}/)
  assert.match(script, /promotionBranchHead\(repository, branch\) \|\|/)
  assert.match(script, /resumingPreparation = checkoutVersion === options\.next/)
  assert.match(script, /requireDevCheckout\(\{allowDirty: resumingPreparation\}\)/)
  assert.match(script, /there is no interrupted preparation to resume/)
  assert.match(script, /requireNextVersion\(currentVersion, nextVersion\)/)
})

test("next-family preparation validates license inventory before mutating files", () => {
  const script = repositoryScript("prepare-next-release-family.mjs")
  const licensePreflight = script.indexOf("prepareLicenseInventory(currentVersion, nextVersion, family)")
  const firstManifestWrite = script.indexOf("updateManifests({currentVersion, nextVersion, family})", licensePreflight)
  const licenseWrite = script.indexOf("licenseInventory.output", firstManifestWrite)

  assert.ok(licensePreflight >= 0)
  assert.ok(firstManifestWrite > licensePreflight)
  assert.ok(licenseWrite > firstManifestWrite)
})

test("external example review replacements are manual and exact-build only", () => {
  const manual = workflow("submit-example-testflight-review.yml")

  assert.match(manual, /workflow_dispatch:/)
  assert.match(manual, /beta_identity:/)
  assert.match(manual, /review_notes:/)
  // The exact build comes from App Store Connect for the beta's version and
  // build number, not from an example record.
  assert.doesNotMatch(manual, /mentra-example-release/)
  assert.match(manual, /echo "build_number=\$\(jq -er \.native\.buildNumber "\$plan"\)"/)
  assert.match(manual, /app-store-connect-build\.mjs lookup/)
  assert.match(manual, /--build-id "\$BUILD_ID"/)
  assert.match(manual, /BUILD_ID: \$\{\{ steps\.build\.outputs\.build_id \}\}/)
  assert.match(manual, /--allow-rejected-override true/)
  assert.match(manual, /app-store-connect-build\.mjs testflight-preflight/)
  assert.match(manual, /app-store-connect-build\.mjs assign/)
  assert.doesNotMatch(manual, /app-store-connect-build\.mjs upload/)
  assert.doesNotMatch(manual, /xcodebuild|npm publish|porter apply/)
})

test("mobile release reads its environment from the backend's Doppler config only", () => {
  const mobile = workflow("reusable-coordinated-mobile.yml")

  for (const suffix of ["DEV", "STG", "PRD"]) {
    assert.match(mobile, new RegExp(`DOPPLER_TOKEN_MOBILE_${suffix}:\\n        required: false`))
    const env = new RegExp(`DOPPLER_TOKEN_MOBILE_${suffix}: \\$\\{\\{ secrets\\.DOPPLER_TOKEN_MOBILE_${suffix} \\}\\}`, "g")
    assert.equal([...mobile.matchAll(env)].length, 2)
  }
  assert.equal([...mobile.matchAll(/case "\$BACKEND_ENVIRONMENT" in/g)].length, 2)
  assert.equal([...mobile.matchAll(/dev\) DOPPLER_TOKEN="\$DOPPLER_TOKEN_MOBILE_DEV"/g)].length, 2)
  assert.equal([...mobile.matchAll(/staging\) DOPPLER_TOKEN="\$DOPPLER_TOKEN_MOBILE_STG"/g)].length, 2)
  assert.equal([...mobile.matchAll(/prod\) DOPPLER_TOKEN="\$DOPPLER_TOKEN_MOBILE_PRD"/g)].length, 2)
  assert.equal([...mobile.matchAll(/shasum -a 256 -c -/g)].length, 2)
  assert.equal([...mobile.matchAll(/secrets download --no-file --format json[^\n]*\|\n\s+node release-tooling\/\.github\/scripts\/prepare-mobile-release-env\.mjs/g)].length, 2)
  assert.doesNotMatch(mobile, /cp mobile\/\.env\.example|DOPPLER_TOKEN_MOBILE_PRD \|\||api\.doppler\.com/)
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
  assert.match(publish, /runs-on: blacksmith-\d+vcpu-ubuntu-2404/)
  assert.match(publish, /timeout-minutes: 5/)
  assert.match(publish, /needs\.ios\.outputs\.upload_artifact/)
  assert.match(publish, /publish-immutable-release-asset\.mjs/)
  assert.match(
    publish,
    /inputs\.dry_run != true && needs\.prepare\.outputs\.ios_asset_exists != 'true'/,
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
        APK_URL: "https://example.com/app.apk",
        IPA_URL: "https://example.com/app.ipa",
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(output, "utf8"), new RegExp(`^ios_result=${expected}$`, "m"))
  }
})

test("new cache and signing tooling tolerate a frozen source predating the helpers", () => {
  const ios = jobBlock(workflow("reusable-coordinated-mobile.yml"), "ios")
  assert.match(ios, /ref: \$\{\{ github.sha \}\}[\s\S]*mobile\/ci\/verify-signing.py/)
  assert.match(ios, /python3 "\$GITHUB_WORKSPACE\/release-tooling\/mobile\/ci\/verify-signing.py"/)
  assert.match(ios, /if \[\[ -f mobile\/scripts\/native-build-cache.mjs \]\] && grep -q MENTRA_NATIVE_BUILD_CACHE/)
  const cache = ios.split("      - name: Compute iOS compilation cache scope\n")[1].split("\n      - name:")[0]
  assert.match(cache, /if: steps.cache-support.outputs.supported == 'true'/)
})


test("cache scope receives the generated public runtime environment, including its backend", () => {
  const source = workflow("reusable-coordinated-mobile.yml")
  const pattern = source.match(/grep -E '([^']+)' mobile\/\.env/)[1]
  const input = "EXPO_PUBLIC_BUILD_ENV=staging\nEXPO_PUBLIC_CLOUD_CORE_URL=https://staging.example\nMENTRAOS_PINNED_BUILD_NUMBER=42\nPRIVATE_TOKEN=secret\n"
  const result = spawnSync("grep", ["-E", pattern], {input, encoding: "utf8"})
  assert.equal(result.status, 0)
  assert.match(result.stdout, /EXPO_PUBLIC_BUILD_ENV=staging/)
  assert.match(result.stdout, /EXPO_PUBLIC_CLOUD_CORE_URL=https:\/\/staging.example/)
  assert.doesNotMatch(result.stdout, /PRIVATE_TOKEN/)
})

// Dev releases come from the Mentra monorepo: this coordinator runs on staging.
test("app cache inputs do not gate coordinated staging cloud deployments", () => {
  const coordinator = workflow("coordinated-release.yml")
  assert.doesNotMatch(coordinator, /^  push:$/m)
  const cloud = jobBlock(coordinator, "cloud-v2")
  assert.match(cloud, /uses: \.\/\.github\/workflows\/reusable-coordinated-cloud-v2.yml/)
  assert.match(cloud, /source_commit: \$\{\{ needs.plan.outputs.source_commit \}\}/)
  assert.match(cloud, /deployment_environment: \$\{\{ needs.plan.outputs.cloud_environment \}\}/)
  assert.doesNotMatch(cloud, /\n    if:/)
  const mobile = jobBlock(coordinator, "mobile")
  assert.match(mobile, /needs: \[plan, ota, cloud-v2\]/)
  assert.doesNotMatch(mobile, /\n    if:/)
})

test("coordinated compiler reuse still generates the current app identity and signs a fresh build", () => {
  const mobile = workflow("reusable-coordinated-mobile.yml")
  for (const platform of ["android", "ios"]) {
    const job = jobBlock(mobile, platform)
    const metadata = job.split("      - name: Generate exact mobile environment and package metadata\n")[1]
      .split("\n      - name:")[0]
    assert.match(metadata, /node release-tooling\/\.github\/scripts\/prepare-mobile-release-env\.mjs/)
    assert.doesNotMatch(metadata, /node \.github\/scripts\/prepare-mobile-release-env/)
    assert.match(metadata, /--plan release-intent\/release-plan.json/)
    for (const key of ["release-identity", "release-set-id", "source-commit", "ota-manifest-url", "ota-manifest-sha256"]) {
      assert.ok(metadata.includes(`--${key} "\${{ `), `${platform}: ${key}`)
    }
    assert.match(metadata, /write-release-metadata.mjs/)
    assert.match(metadata, /MENTRAOS_PINNED_BUILD_NUMBER/)
    assert.ok(job.includes(`bun run release:${platform}`))
    assert.doesNotMatch(job, /cache-hit/)
  }
  const android = jobBlock(mobile, "android")
  assert.match(android, /gradle\/actions\/setup-gradle@v4/)
  assert.match(android, /cache-read-only: false/)
  assert.doesNotMatch(android, /hashFiles|cloud-v2\/\*\*/)
  assert.match(android, /Verify Android native version and production signature/)
  assert.match(mobileScript("release-android.mjs"), /assembleRelease[^\n]*--build-cache/)
  assert.match(mobileScript("release-android.mjs"), /bundleRelease[^\n]*--build-cache/)
  const ios = jobBlock(mobile, "ios")
  assert.match(ios, /mobile\/build\/CompilationCache\n\s+mobile\/build\/DerivedData\/SourcePackages/)
  assert.match(ios, /Install iOS signing assets/)
})

test("a dry run publishes nothing to the stores", () => {
  const core = workflow("coordinated-release.yml")
  for (const job of ["examples", "example-testflight", "example-google-play"]) {
    assert.match(jobBlock(core, job), /^    if: needs\.plan\.outputs\.dry_run != 'true'$/m, job)
  }
  // Every job that calls a store workflow is guarded.
  for (const [, job] of core.matchAll(/\n  ([a-z0-9-]+):\n(?:(?!\n  [a-z0-9-]+:\n)[\s\S])*?uses: \.\/\.github\/workflows\/reusable-coordinated-example-(?:testflight|google-play)\.yml/g)) {
    assert.match(jobBlock(core, job), /dry_run != 'true'/, job)
  }
  // The release page and docs follow the guarded jobs, so a dry run deploys neither.
  assert.match(jobBlock(core, "release-page"), /needs\.plan\.outputs\.dry_run != 'true'/)
  assert.match(jobBlock(core, "docs"), /^    needs: \[plan, examples, example-testflight\]$/m)
})

test("the docs verification receives the release identity and both example links", () => {
  const docs = jobBlock(workflow("coordinated-release.yml"), "docs")
  const step = docs.split("      - name: Prepare and verify the Cloudflare Pages artifact\n")[1].split("\n      - name:")[0]
  assert.match(step, /verify-coordinated-docs\.mjs/)
  assert.match(step, /RELEASE_IDENTITY: \$\{\{ needs\.plan\.outputs\.release_identity \}\}/)
  assert.match(step, /EXAMPLE_APK_URL: \$\{\{ needs\.examples\.outputs\.react_native_url \}\}/)
  assert.match(step, /EXAMPLE_IOS_URL: \$\{\{ needs\.example-testflight\.outputs\.install_url \}\}/)
  // The script reads exactly these variables.
  const script = readFileSync(new URL("verify-coordinated-docs.mjs", import.meta.url), "utf8")
  for (const name of ["RELEASE_IDENTITY", "EXAMPLE_APK_URL", "EXAMPLE_IOS_URL"]) {
    assert.match(script, new RegExp(`process\\.env\\.${name}`), name)
  }
})

// GITHUB_TOKEN cannot hold the workflows permission, and GitHub's workflow-file
// check for a new tag on a branch far from dev times out as HTTP 403. Every
// step that creates a release tag uses the release coordinator App's token.
test("release tags are created with the release coordinator App token", () => {
  const steps = [
    ["reusable-coordinated-runtime-image.yml", "Publish persistent installer downloads"],
    ["coordinated-release.yml", "Tag and verify the completed release set"],
    ["coordinated-release.yml", "Publish direct app downloads from the completed release"],
  ]
  for (const [file, name] of steps) {
    const source = workflow(file)
    const start = source.indexOf(`      - name: ${name}\n`)
    assert.ok(start > 0, `${file}: ${name}`)
    const step = source.slice(start).split("\n      - name:")[0]
    assert.match(step, /GH_TOKEN: \$\{\{ steps\.release-token\.outputs\.token \}\}/, `${file}: ${name}`)
    const mint = source.slice(source.lastIndexOf("      - name: Mint release token\n", start), start)
    assert.match(mint, /uses: actions\/create-github-app-token@/, `${file}: ${name}`)
    assert.match(mint, /app-id: \$\{\{ vars\.STARTER_KIT_COORDINATOR_APP_ID \}\}/)
    assert.match(mint, /permission-workflows: write/)
    assert.match(mint, /permission-contents: write/)
    assert.doesNotMatch(mint, /\n      - name: (?!Mint release token)/, `${file}: ${name} must follow its own mint step`)
  }
})
