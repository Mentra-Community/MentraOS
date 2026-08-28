#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {loadReleaseFamily} from "./release-family.mjs"

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

export function stageReleaseFamily({rootDir = process.cwd(), plan}) {
  const family = loadReleaseFamily({rootDir, requireVersionMirrors: true})
  if (plan.familyBaseVersion !== family.familyBaseVersion) {
    throw new Error(
      `Release plan base ${JSON.stringify(plan.familyBaseVersion)} does not match source ${family.familyBaseVersion}`,
    )
  }
  if (JSON.stringify(plan.changelog) !== JSON.stringify(family.changelog)) {
    throw new Error("Release plan changelog does not match the source changelog")
  }
  if (!plan.releaseIdentity || plan.releaseSetId !== `mentra-${plan.releaseIdentity}`) {
    throw new Error("Release plan has an invalid release identity")
  }

  const planMembers = Object.keys(plan.members || {}).sort()
  const familyMembers = family.members.map(({name}) => name).sort()
  if (JSON.stringify(planMembers) !== JSON.stringify(familyMembers)) {
    throw new Error("Release plan members do not match the configured release family")
  }

  const changes = []
  for (const member of family.members) {
    const planned = plan.members[member.name]
    if (planned.version !== plan.releaseIdentity) {
      throw new Error(`${member.name} plan version does not match ${plan.releaseIdentity}`)
    }
    const manifestPath = path.join(rootDir, member.manifest)
    const manifest = readJson(manifestPath)
    manifest.version = plan.releaseIdentity

    for (const dependency of member.dependencies) {
      const expected = member.name === "mentraos" ? "workspace:*" : plan.releaseIdentity
      if (!manifest.dependencies || manifest.dependencies[dependency] === undefined) {
        throw new Error(`${member.manifest} is missing dependencies.${dependency}`)
      }
      manifest.dependencies[dependency] = expected
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    changes.push({name: member.name, manifest: member.manifest, version: plan.releaseIdentity})
  }
  return changes
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

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.plan) throw new Error("Missing --plan")
  const rootDir = path.resolve(args.root || process.cwd())
  const plan = readJson(path.resolve(args.plan))
  const changes = stageReleaseFamily({rootDir, plan})
  console.log(`Staged ${changes.length} release-family manifests at ${plan.releaseIdentity}`)
}
