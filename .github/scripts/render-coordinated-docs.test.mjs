import assert from "node:assert/strict"
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {renderCoordinatedDocs} from "./render-coordinated-docs.mjs"

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "coordinated-docs-"))
  const source = path.join(root, "source")
  mkdirSync(source)
  writeFileSync(
    path.join(source, "docs.json"),
    JSON.stringify({
      name: "MentraOS",
      variables: {
        "release-version": "3.1.0",
        "release-artifacts-url": "https://example.com/stable",
        "example-app-version": "0.1.21-beta.5",
        "example-app-url": "https://example.com/example.apk",
      },
    }),
  )
  writeFileSync(path.join(source, "page.mdx"), "Release {{release-version}}")
  return {root, source, output: path.join(root, "output")}
}

test("renders exact coordinated release variables without changing source", (context) => {
  const {root, source, output} = fixture()
  context.after(() => rmSync(root, {recursive: true, force: true}))
  const plan = {
    releaseIdentity: "3.1.0-beta.57",
    releaseSetId: "mentra-3.1.0-beta.57",
    artifactContainerTag: "mentra-builds-v3.1.0",
    sourceCommit: "a".repeat(40),
  }
  const starterKitResult = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    mentraos: {sourceCommit: plan.sourceCommit},
    artifacts: [
      {
        key: "reactNative",
        url: "https://github.com/Mentra/Starter/releases/download/sdk-builds-v3.1.0/example.apk",
      },
    ],
  }

  renderCoordinatedDocs({
    sourceDir: source,
    outputDir: output,
    releasePlan: plan,
    starterKitResult,
    repository: "Mentra/MentraOS",
  })

  const rendered = JSON.parse(readFileSync(path.join(output, "docs.json"), "utf8"))
  const original = JSON.parse(readFileSync(path.join(source, "docs.json"), "utf8"))
  assert.equal(rendered.variables["release-version"], "3.1.0-beta.57")
  assert.equal(
    rendered.variables["release-artifacts-url"],
    "https://github.com/Mentra/MentraOS/releases/tag/mentra-builds-v3.1.0",
  )
  assert.equal(rendered.variables["example-app-version"], "3.1.0-beta.57")
  assert.equal(rendered.variables["example-app-url"], starterKitResult.artifacts[0].url)
  assert.equal(original.variables["release-version"], "3.1.0")
  assert.equal(readFileSync(path.join(output, "page.mdx"), "utf8"), "Release {{release-version}}")
})

test("rejects an inconsistent release plan", (context) => {
  const {root, source, output} = fixture()
  context.after(() => rmSync(root, {recursive: true, force: true}))
  assert.throws(
    () =>
      renderCoordinatedDocs({
        sourceDir: source,
        outputDir: output,
        releasePlan: {
          releaseIdentity: "3.1.0-dev.4",
          releaseSetId: "mentra-wrong",
          artifactContainerTag: "mentra-builds-v3.1.0",
        },
        repository: "Mentra/MentraOS",
      }),
    /inconsistent release-set identity/,
  )
})

test("rejects prerelease docs without matching example artifacts", (context) => {
  const {root, source, output} = fixture()
  context.after(() => rmSync(root, {recursive: true, force: true}))
  assert.throws(
    () =>
      renderCoordinatedDocs({
        sourceDir: source,
        outputDir: output,
        releasePlan: {
          releaseIdentity: "3.1.0-dev.4",
          releaseSetId: "mentra-3.1.0-dev.4",
          artifactContainerTag: "mentra-builds-v3.1.0",
          sourceCommit: "a".repeat(40),
        },
        repository: "Mentra/MentraOS",
      }),
    /require a Starter Kit result/,
  )
})

test("Mentra Live current-release copy uses configured variables", () => {
  const docsRoot = fileURLToPath(new URL("../../mintlify-docs/mentra-live/", import.meta.url))
  const files = readdirSync(docsRoot, {recursive: true}).filter((file) => file.endsWith(".mdx"))
  const content = files.map((file) => readFileSync(path.join(docsRoot, file), "utf8")).join("\n")

  assert.doesNotMatch(content, /0\.1\.21-beta\.5/)
  assert.doesNotMatch(content, /bluetooth-sdk-ota|asg-client-sdk/)
  assert.match(content, /\{\{release-version\}\}/)
})
