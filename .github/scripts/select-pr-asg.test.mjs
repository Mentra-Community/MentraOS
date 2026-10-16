import assert from "node:assert/strict"
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {existingPrAsg, prAsgManifestAsset, readFamilyBaseVersion, selectPrAsg} from "./select-pr-asg.mjs"

const fingerprint = "a".repeat(64)
const other = "b".repeat(64)

function asset(id, versionCode, selectedFingerprint, extension) {
  return {id, name: `mentra-live-asg-${versionCode}-${selectedFingerprint}.${extension}`}
}

test("reuses the coordinated build whose fingerprint matches the PR sources", () => {
  const selection = selectPrAsg({
    assets: [
      asset(1, 302_000_001, other, "apk"),
      asset(2, 302_000_001, other, "json"),
      asset(3, 302_000_002, fingerprint, "apk"),
      asset(4, 302_000_002, fingerprint, "json"),
    ],
    fingerprint,
    baseVersion: "3.2.0",
  })
  assert.deepEqual(selection, {
    mode: "reuse",
    fingerprint,
    baseVersion: "3.2.0",
    versionCode: 302_000_002,
    apkAsset: `mentra-live-asg-302000002-${fingerprint}.apk`,
    provenanceAsset: `mentra-live-asg-302000002-${fingerprint}.json`,
  })
})

test("builds when no coordinated artifact carries the PR fingerprint", () => {
  const selection = selectPrAsg({
    assets: [asset(1, 302_000_001, other, "apk"), asset(2, 302_000_001, other, "json")],
    fingerprint,
    baseVersion: "3.2.0",
  })
  assert.deepEqual(selection, {mode: "build", fingerprint, baseVersion: "3.2.0"})
})

test("builds when the coordinated pair for the fingerprint is incomplete", () => {
  // An APK without its provenance (or vice versa) is an interrupted release
  // upload; the release lane rebuilds it and so does the PR.
  const selection = selectPrAsg({
    assets: [asset(1, 302_000_002, fingerprint, "apk")],
    fingerprint,
    baseVersion: "3.2.0",
  })
  assert.equal(selection.mode, "build")
})

test("reads the family base version from the root package manifest", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-select-pr-asg-"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "3.2.0"}))
  assert.equal(readFamilyBaseVersion(root), "3.2.0")
  writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "3.2.0-dev.4"}))
  assert.throws(() => readFamilyBaseVersion(root), /plain X\.Y\.Z family base version/)
})

test("redelivery reuses the committed manifest and refuses a different source or artifact", () => {
  const headSha = 'c'.repeat(40), hash = 'd'.repeat(64), pr = 12
  const firmware = {mtk_patches: [{from: 'one', to: 'two'}], bes_firmware: {version: 'two'}}
  const url = `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/asg-pr-12-${headSha}-${hash}.apk`
  const asset = {url, state: 'uploaded', size: 123, digest: `sha256:${hash}`}
  const manifest = {releaseVersion: `pr-${pr}-${headSha}`, asgSource: {fingerprint}, ...firmware,
    apps: {'com.mentra.asg_client': {versionCode: 303000001, versionName: '3.3.0-pr.12', apkUrl: url, apkSize: 123, sha256: hash}}}
  const input = {manifest, assets: [asset], fingerprint, firmware, pr, headSha}
  assert.deepEqual(existingPrAsg(input), {mode: 'published', fingerprint, versionCode: 303000001})
  for (const change of [{fingerprint: other}, {headSha: 'e'.repeat(40)}, {assets: []},
    {assets: [{...asset, size: 124}]}, {assets: [{...asset, digest: `sha256:${other}`} ]},
    {firmware: {...firmware, bes_firmware: {version: 'other'}}}])
    assert.throws(() => existingPrAsg({...input, ...change}), /differs/)
})

test("one exact manifest is reused; duplicate, partial or wrongly owned publications refuse", () => {
  const head = 'c'.repeat(40), name = `ota-pr-12-${head}.json`
  const row = {name, state: 'uploaded', url: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/${name}`}
  assert.equal(prAsgManifestAsset([], 12, head), undefined)
  assert.equal(prAsgManifestAsset([row], 12, head), row)
  assert.throws(() => prAsgManifestAsset([row, row], 12, head), /Duplicate/)
  for (const change of [{state: 'starter'}, {url: 'https://example.com/wrong'}])
    assert.throws(() => prAsgManifestAsset([{...row, ...change}], 12, head), /incomplete/)
})

test("PR event and explicit intake serialize by exact source and never overwrite accepted bytes", () => {
  const workflow = readFileSync(new URL('../workflows/mentra-asg-client-build.yml', import.meta.url), 'utf8')
  assert.match(workflow, /group: asg-client-build-\$\{\{ github.event.pull_request.number \|\| inputs.routine_pr \|\| github.ref \}\}-\$\{\{ github.event.pull_request.head.sha \|\| inputs.routine_head_sha \|\| github.sha \}\}/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.doesNotMatch(workflow, /--replace true/)
  assert.match(workflow, /name="asg-pr-\$\{PR_NUMBER\}-\$\{HEAD_SHA\}-\$\{digest\}\.apk"/)
  assert.match(workflow, /--pr "\$PR_NUMBER" --head "\$HEAD_SHA" --pr-assets/)
})

test("explicit ASG reuse publishes its manifest without entering the PR-only comment step", () => {
  const workflow = readFileSync(new URL("../workflows/mentra-asg-client-build.yml", import.meta.url), "utf8")
  function condition(name) {
    const expression = workflow.split(`- name: ${name}\n`)[1]?.match(/^\s+if: (.+)$/m)?.[1]
    assert.ok(expression, `Missing condition for ${name}`)
    return new Function("github", "steps", `return (${expression});`)
  }
  const publish = condition("Publish the OTA manifest for the reused ASG client")
  const comment = condition("Update PR comment - Reused coordinated build")
  const steps = {select: {outputs: {mode: "reuse"}}}
  assert.equal(publish({event_name: "workflow_dispatch"}, steps), true)
  assert.equal(comment({event_name: "workflow_dispatch"}, steps), false)
  assert.equal(comment({event_name: "pull_request"}, steps), true)
  assert.equal(comment({event_name: "pull_request"}, {select: {outputs: {mode: "build"}}}), false)
})
