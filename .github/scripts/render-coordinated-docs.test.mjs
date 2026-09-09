import assert from "node:assert/strict"
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
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
        "example-app-download-label": "Browse React Native example APK releases",
        "example-app-url": "https://github.com/Mentra/Starter/releases",
        "example-app-ios-url": "https://testflight.apple.com/join/source",
      },
    }),
  )
  writeFileSync(
    path.join(source, "page.mdx"),
    [
      "Release {{release-version}}",
      "[{{example-app-download-label}}]({{example-app-url}})",
      "[iPhone]({{example-app-ios-url}})",
      "[Artifacts]({{release-artifacts-url}})",
    ].join("\n"),
  )
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
    channel: "beta",
    native: {marketingVersion: "3.1.0", buildNumber: 310000057},
  }
  const starterKitResult = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    mentraos: {sourceCommit: plan.sourceCommit},
    starterKit: {releaseCommit: "b".repeat(40)},
    artifacts: [
      {
        key: "reactNative",
        url: "https://github.com/Mentra/Starter/releases/download/sdk-builds-v3.1.0/example.apk",
      },
    ],
  }
  const exampleTestflightResult = {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    mentraosSourceCommit: plan.sourceCommit,
    starterKitReleaseCommit: starterKitResult.starterKit.releaseCommit,
    version: plan.native,
    group: {id: "group-public", name: "Mentra Staging Public"},
    distribution: {
      audience: "external",
      status: "submitted",
      installUrl: "https://testflight.apple.com/join/public123",
    },
  }

  renderCoordinatedDocs({
    sourceDir: source,
    outputDir: output,
    releasePlan: plan,
    starterKitResult,
    exampleTestflightResult,
    repository: "Mentra/MentraOS",
  })

  const rendered = JSON.parse(readFileSync(path.join(output, "docs.json"), "utf8"))
  const original = JSON.parse(readFileSync(path.join(source, "docs.json"), "utf8"))
  assert.equal(rendered.variables["release-version"], "3.1.0-beta.57")
  assert.equal(
    rendered.variables["release-artifacts-url"],
    "https://github.com/Mentra/MentraOS/releases/tag/mentra-builds-v3.1.0",
  )
  assert.equal(
    rendered.variables["example-app-download-label"],
    "Download the React Native example APK for SDK 3.1.0-beta.57",
  )
  assert.equal(rendered.variables["example-app-url"], starterKitResult.artifacts[0].url)
  assert.equal(rendered.variables["example-app-ios-url"], exampleTestflightResult.distribution.installUrl)
  assert.equal(original.variables["release-version"], "3.1.0")
  assert.equal(original.variables["example-app-download-label"], "Browse React Native example APK releases")
  assert.equal(original.variables["example-app-url"], "https://github.com/Mentra/Starter/releases")
  assert.equal(
    readFileSync(path.join(output, "page.mdx"), "utf8"),
    [
      "Release 3.1.0-beta.57",
      `[Download the React Native example APK for SDK 3.1.0-beta.57](${starterKitResult.artifacts[0].url})`,
      `[iPhone](${exampleTestflightResult.distribution.installUrl})`,
      "[Artifacts](https://github.com/Mentra/MentraOS/releases/tag/mentra-builds-v3.1.0)",
    ].join("\n"),
  )
  assert.match(readFileSync(path.join(source, "page.mdx"), "utf8"), /\{\{example-app-url\}\}/)
})

test("source-only and stable docs use honest version-neutral example links", (context) => {
  const {root, source, output} = fixture()
  context.after(() => rmSync(root, {recursive: true, force: true}))
  const docsRoot = fileURLToPath(new URL("../../mintlify-docs/", import.meta.url))
  const sourceConfig = readFileSync(path.join(docsRoot, "docs.json"), "utf8")
  const {variables} = JSON.parse(sourceConfig)
  writeFileSync(path.join(source, "docs.json"), sourceConfig)

  assert.equal(variables["example-app-download-label"], "Browse React Native example APK releases")
  assert.equal(variables["example-app-url"], "https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit/releases")
  assert.equal(variables["example-app-version"], undefined)

  for (const file of ["software-update.mdx", "quickstart.mdx"]) {
    const content = readFileSync(path.join(docsRoot, "bluetooth-sdk", file), "utf8")
    assert.doesNotMatch(content, /\{\{example-app-version\}\}|This is the exact Android build/)
    writeFileSync(path.join(source, file), content)
  }

  renderCoordinatedDocs({
    sourceDir: source,
    outputDir: output,
    releasePlan: {
      releaseIdentity: variables["release-version"],
      releaseSetId: `mentra-${variables["release-version"]}`,
      artifactContainerTag: `mentra-v${variables["release-version"]}`,
    },
    repository: "Mentra-Community/MentraOS",
  })

  const rendered = JSON.parse(readFileSync(path.join(output, "docs.json"), "utf8"))
  assert.deepEqual(rendered.variables, variables)
  assert.match(
    readFileSync(path.join(output, "software-update.mdx"), "utf8"),
    /\[Browse React Native example APK releases\]\(https:\/\/github\.com\/Mentra-Community\/Mentra-Bluetooth-SDK-Starter-Kit\/releases\)/,
  )
  assert.equal(readFileSync(path.join(source, "docs.json"), "utf8"), sourceConfig)
})

test("rejects unresolved documentation variables", (context) => {
  const {root, source, output} = fixture()
  context.after(() => rmSync(root, {recursive: true, force: true}))
  writeFileSync(path.join(source, "page.mdx"), "[Unknown]({{unknown-url}})")

  assert.throws(
    () =>
      renderCoordinatedDocs({
        sourceDir: source,
        outputDir: output,
        releasePlan: {
          releaseIdentity: "3.1.0",
          releaseSetId: "mentra-3.1.0",
          artifactContainerTag: "mentra-builds-v3.1.0",
        },
        repository: "Mentra/MentraOS",
      }),
    /Unresolved documentation variable/,
  )
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

test("Bluetooth SDK current-release copy uses configured variables", () => {
  const docsRoot = fileURLToPath(new URL("../../mintlify-docs/bluetooth-sdk/", import.meta.url))
  const files = readdirSync(docsRoot, {recursive: true}).filter((file) => file.endsWith(".mdx"))
  const content = files.map((file) => readFileSync(path.join(docsRoot, file), "utf8")).join("\n")

  assert.doesNotMatch(content, /\d+\.\d+\.\d+-(?:beta|dev)\.\d+/)
  assert.doesNotMatch(content, /bluetooth-sdk-ota|asg-client-sdk/)
  assert.match(content, /\{\{release-version\}\}/)
  const configPath = fileURLToPath(new URL("../../mintlify-docs/docs.json", import.meta.url))
  const {variables} = JSON.parse(readFileSync(configPath, "utf8"))
  assert.doesNotMatch(JSON.stringify(variables), /\d+\.\d+\.\d+-(?:beta|dev)\.\d+/)
})

test("air-gapped deployment is not published or linked", () => {
  const docsRoot = fileURLToPath(new URL("../../mintlify-docs/", import.meta.url))
  const config = JSON.parse(readFileSync(path.join(docsRoot, "docs.json"), "utf8"))
  const files = readdirSync(docsRoot, {recursive: true}).filter((file) => file.endsWith(".mdx"))
  const content = files.map((file) => readFileSync(path.join(docsRoot, file), "utf8")).join("\n")
  const sdkReadme = readFileSync(
    fileURLToPath(new URL("../../mobile/modules/bluetooth-sdk/README.md", import.meta.url)),
    "utf8",
  )

  assert.doesNotMatch(JSON.stringify(config), /air-gapped-deployment/)
  assert.doesNotMatch(content, /\/bluetooth-sdk\/air-gapped-deployment/)
  assert.doesNotMatch(sdkReadme, /\/bluetooth-sdk\/air-gapped-deployment/)
  assert.equal(
    existsSync(path.join(docsRoot, "bluetooth-sdk/air-gapped-deployment.mdx")),
    false,
  )
})
