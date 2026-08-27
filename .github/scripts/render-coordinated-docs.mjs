#!/usr/bin/env node
import {cpSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

const RELEASE_IDENTITY_PATTERN = /^\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?$/

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

export function renderCoordinatedDocs({sourceDir, outputDir, releasePlan, repository}) {
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
  for (const name of ["release-version", "release-artifacts-url", "example-app-version", "example-app-url"]) {
    if (typeof config.variables[name] !== "string" || config.variables[name].length === 0) {
      throw new Error(`mintlify-docs/docs.json is missing variable ${name}`)
    }
  }

  config.variables["release-version"] = releasePlan.releaseIdentity
  config.variables["release-artifacts-url"] =
    `https://github.com/${repository}/releases/tag/${releasePlan.artifactContainerTag}`
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  return {releaseIdentity: releasePlan.releaseIdentity, outputDir: output}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  const result = renderCoordinatedDocs({
    sourceDir: path.resolve(args.source),
    outputDir: path.resolve(args.output),
    releasePlan: plan,
    repository: args.repository,
  })
  console.log(`Rendered docs for ${result.releaseIdentity} in ${result.outputDir}`)
}
