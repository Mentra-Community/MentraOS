#!/usr/bin/env node
import {loadReleaseFamily} from "./release-family.mjs"

const [command, ...args] = process.argv.slice(2)

if (command !== "validate") {
  console.error("Usage: release-family-cli.mjs validate [--require-version-mirrors]")
  process.exit(2)
}

const unknownArgs = args.filter((argument) => argument !== "--require-version-mirrors")
if (unknownArgs.length > 0) {
  console.error(`Unknown arguments: ${unknownArgs.join(", ")}`)
  process.exit(2)
}

const family = loadReleaseFamily({requireVersionMirrors: args.includes("--require-version-mirrors")})
console.log(
  `Release family ${family.family}@${family.familyBaseVersion} is valid: ` +
    `${family.products.length} products, ${family.members.length} members`,
)
console.log(`Publication order: ${family.publicationOrder.join(" -> ")}`)
