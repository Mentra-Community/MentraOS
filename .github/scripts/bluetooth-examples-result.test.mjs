import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  EXAMPLE_ARTIFACTS,
  createExamplesBuild,
  exampleArtifactName,
  locateExamples,
  validateExamplesResult,
} from "./bluetooth-examples-result.mjs"

const plan = {
  releaseSetId: "mentra-3.4.0-dev.1040",
  releaseIdentity: "3.4.0-dev.1040",
  familyBaseVersion: "3.4.0",
  channel: "dev",
  sourceCommit: "a".repeat(40),
  artifactContainerTag: "mentra-builds-v3.4.0",
}
const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/1"

function builtExamples(t, names = EXAMPLE_ARTIFACTS.map(({key}) => exampleArtifactName(key, plan.releaseIdentity))) {
  const directory = mkdtempSync(path.join(tmpdir(), "bluetooth-examples-"))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  return names.map((name, index) => {
    const file = path.join(directory, `job-${index}`, name)
    mkdirSync(path.dirname(file), {recursive: true})
    writeFileSync(file, `bytes of ${name}`)
    return file
  })
}

function build(t, files = builtExamples(t)) {
  return createExamplesBuild({
    plan,
    files,
    otaManifestUrl: "https://artifactscdn.mentraglass.com/x/mentra-live-ota-3.4.0-dev.1040.json",
    otaManifestSha256: "c".repeat(64),
    provenanceUrl,
  })
}

function listing(result, overrides = {}) {
  return result.artifacts.map((artifact) => ({
    name: artifact.name,
    state: "uploaded",
    size: artifact.size,
    digest: `sha256:${artifact.sha256}`,
    ...overrides[artifact.name],
  }))
}

test("describes exactly the four release-named example builds", (t) => {
  const result = build(t)
  assert.deepEqual(
    result.artifacts.map(({name}) => name),
    [
      "mentra-example-android-3.4.0-dev.1040.apk",
      "mentra-example-ios-3.4.0-dev.1040-unsigned.ipa",
      "mentra-example-react-native-3.4.0-dev.1040.apk",
      "mentra-example-rn-elevenlabs-audio-3.4.0-dev.1040.apk",
    ],
  )
  assert.equal(result.sourceCommit, plan.sourceCommit)
  assert.equal(result.sourcePath, "examples/bluetooth")
  assert.equal(
    result.artifacts[0].sha256,
    createHash("sha256").update("bytes of mentra-example-android-3.4.0-dev.1040.apk").digest("hex"),
  )
  assert.equal(validateExamplesResult(plan, result, {located: false}), result)
  assert.throws(() => validateExamplesResult(plan, result), /is invalid/)

  const files = builtExamples(t)
  assert.throws(() => build(t, files.slice(1)), /Expected exactly one built example named mentra-example-android/)
  assert.throws(() => build(t, [...files, files[0]]), /found 2/)
  assert.throws(
    () => build(t, builtExamples(t, ["mentra-example-android-3.4.0-dev.1039.apk"])),
    /mentra-example-android-3\.4\.0-dev\.1040\.apk/,
  )
})

test("locates each build in the release container, keeping bytes an earlier attempt published", (t) => {
  const result = build(t)
  const located = locateExamples({
    plan,
    build: result,
    repository: "Mentra-Community/MentraOS",
    containerTag: plan.artifactContainerTag,
    assets: listing(result),
  })
  assert.ok(located.artifacts.every(({status}) => status === "published"))
  assert.equal(
    located.artifacts[2].url,
    "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-builds-v3.4.0/mentra-example-react-native-3.4.0-dev.1040.apk",
  )
  const rerun = locateExamples({
    plan,
    build: result,
    repository: "Mentra-Community/MentraOS",
    containerTag: plan.artifactContainerTag,
    assets: listing(result, {[result.artifacts[0].name]: {digest: `sha256:${"e".repeat(64)}`, size: 9}}),
  })
  assert.deepEqual(rerun.artifacts[0], {...located.artifacts[0], sha256: "e".repeat(64), size: 9, status: "reused"})
  assert.throws(
    () =>
      locateExamples({
        plan,
        build: result,
        repository: "Mentra-Community/MentraOS",
        containerTag: plan.artifactContainerTag,
        assets: listing(result).slice(1),
      }),
    /is not published/,
  )
  assert.throws(
    () =>
      locateExamples({
        plan,
        build: result,
        repository: "Mentra-Community/MentraOS",
        containerTag: "mentra-builds-v3.3.0",
        assets: listing(result),
      }),
    /release container/,
  )
  assert.throws(() => validateExamplesResult({...plan, sourceCommit: "b".repeat(40)}, located), /do not match/)
})
