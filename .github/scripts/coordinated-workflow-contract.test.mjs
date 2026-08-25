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
  assert.match(ota, /\{draft: false, prerelease: true, body: \$body\}/)
  assert.doesNotMatch(ota, /OTA_RELEASE_TAG/)
})

test("production validates before approval and proves packages before mobile promotion", () => {
  const production = workflow("coordinated-production-promotion.yml")

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
})
