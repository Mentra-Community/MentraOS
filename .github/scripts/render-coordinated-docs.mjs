#!/usr/bin/env node
import {cpSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

const RELEASE_IDENTITY_PATTERN = /^\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?$/

function renderUrlVariables(directory, variables) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      renderUrlVariables(entryPath, variables)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".mdx")) continue

    const source = readFileSync(entryPath, "utf8")
    const rendered = Object.entries(variables)
      .filter(([name]) => name.endsWith("-url"))
      .reduce((content, [name, value]) => content.replaceAll(`{{${name}}}`, value), source)
    if (/\{\{[A-Za-z0-9_-]+-url\}\}/.test(rendered)) {
      throw new Error(`Unresolved URL variable in ${entryPath}`)
    }
    if (rendered !== source) writeFileSync(entryPath, rendered)
  }
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

function validateStarterKitResult(releasePlan, starterKitResult) {
  if (!starterKitResult) throw new Error("Coordinated prerelease docs require a Starter Kit result")
  if (
    starterKitResult.schemaVersion !== 1 ||
    starterKitResult.releaseSetId !== releasePlan.releaseSetId ||
    starterKitResult.releaseIdentity !== releasePlan.releaseIdentity ||
    starterKitResult.mentraos?.sourceCommit !== releasePlan.sourceCommit
  ) {
    throw new Error("Starter Kit result does not match the coordinated release plan")
  }
  const reactNative = starterKitResult.artifacts?.find((artifact) => artifact.key === "reactNative")
  if (!reactNative || !/^https:\/\//.test(reactNative.url || "")) {
    throw new Error("Starter Kit result is missing the React Native APK")
  }
  return reactNative
}

function validateExampleTestflightResult(releasePlan, starterKitResult, exampleTestflightResult) {
  const expectedGroup = releasePlan.channel === "dev" ? "Mentra Dev" : "Mentra Staging Public"
  const expectedAudience = releasePlan.channel === "dev" ? "internal" : "external"
  if (
    exampleTestflightResult?.schemaVersion !== 1 ||
    exampleTestflightResult.releaseSetId !== releasePlan.releaseSetId ||
    exampleTestflightResult.releaseIdentity !== releasePlan.releaseIdentity ||
    exampleTestflightResult.channel !== releasePlan.channel ||
    exampleTestflightResult.mentraosSourceCommit !== releasePlan.sourceCommit ||
    exampleTestflightResult.starterKitReleaseCommit !== starterKitResult?.starterKit?.releaseCommit ||
    exampleTestflightResult.version?.marketingVersion !== releasePlan.native?.marketingVersion ||
    exampleTestflightResult.version?.buildNumber !== releasePlan.native?.buildNumber ||
    exampleTestflightResult.group?.name !== expectedGroup ||
    exampleTestflightResult.distribution?.audience !== expectedAudience ||
    !["available", "submitted", "skipped"].includes(exampleTestflightResult.distribution?.status)
  ) {
    throw new Error("Example TestFlight result does not match the coordinated release")
  }
  const installUrl = exampleTestflightResult.distribution.installUrl
  if (!/^https:\/\//.test(installUrl || "")) throw new Error("Example TestFlight result has no install URL")
  if (expectedAudience === "external" && !/^https:\/\/testflight\.apple\.com\/join\//.test(installUrl)) {
    throw new Error("External example TestFlight result has no public invitation link")
  }
  return installUrl
}

export function renderCoordinatedDocs({
  sourceDir,
  outputDir,
  releasePlan,
  starterKitResult,
  exampleTestflightResult,
  repository,
}) {
  if (!RELEASE_IDENTITY_PATTERN.test(releasePlan?.releaseIdentity || "")) {
    throw new Error(`Invalid coordinated release identity ${JSON.stringify(releasePlan?.releaseIdentity)}`)
  }
  if (releasePlan.releaseSetId !== `mentra-${releasePlan.releaseIdentity}`) {
    throw new Error("Release plan has an inconsistent release-set identity")
  }
  if (!releasePlan.artifactContainerTag) throw new Error("Release plan is missing its artifact container tag")
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(repository)}`)
  }

  const source = realpathSync(sourceDir)
  const output = path.resolve(outputDir)
  if (output === source || output.startsWith(`${source}${path.sep}`)) {
    throw new Error("Rendered docs output must be outside the source tree")
  }

  rmSync(output, {recursive: true, force: true})
  cpSync(source, output, {recursive: true})

  const configPath = path.join(output, "docs.json")
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  if (!config.variables || typeof config.variables !== "object" || Array.isArray(config.variables)) {
    throw new Error("mintlify-docs/docs.json must define release variables")
  }
  for (const name of [
    "release-version",
    "release-artifacts-url",
    "example-app-version",
    "example-app-url",
    "example-app-ios-url",
  ]) {
    if (typeof config.variables[name] !== "string" || config.variables[name].length === 0) {
      throw new Error(`mintlify-docs/docs.json is missing variable ${name}`)
    }
  }

  config.variables["release-version"] = releasePlan.releaseIdentity
  config.variables["release-artifacts-url"] =
    `https://github.com/${repository}/releases/tag/${releasePlan.artifactContainerTag}`
  if (releasePlan.releaseIdentity.includes("-")) {
    const reactNative = validateStarterKitResult(releasePlan, starterKitResult)
    config.variables["example-app-version"] = releasePlan.releaseIdentity
    config.variables["example-app-url"] = reactNative.url
    config.variables["example-app-ios-url"] = validateExampleTestflightResult(
      releasePlan,
      starterKitResult,
      exampleTestflightResult,
    )
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  renderUrlVariables(output, config.variables)

  return {releaseIdentity: releasePlan.releaseIdentity, outputDir: output}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  const starterKitResult = args["starter-kit"]
    ? JSON.parse(readFileSync(path.resolve(args["starter-kit"]), "utf8"))
    : undefined
  const exampleTestflightResult = args["example-testflight"]
    ? JSON.parse(readFileSync(path.resolve(args["example-testflight"]), "utf8"))
    : undefined
  const result = renderCoordinatedDocs({
    sourceDir: path.resolve(args.source),
    outputDir: path.resolve(args.output),
    releasePlan: plan,
    starterKitResult,
    exampleTestflightResult,
    repository: args.repository,
  })
  console.log(`Rendered docs for ${result.releaseIdentity} in ${result.outputDir}`)
}
