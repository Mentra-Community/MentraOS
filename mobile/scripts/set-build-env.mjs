#!/usr/bin/env zx
import {config} from "dotenv"
import {writeFile} from "fs/promises"

export async function setBuildEnv() {
  const gitCommit = (await $`git rev-parse --short HEAD`).stdout.trim()
  const gitBranch = (await $`git rev-parse --abbrev-ref HEAD`).stdout.trim()
  const gitUsername = (await $`git config user.name`).stdout.trim().replace(/ /g, "_")  // format: 2025-11-18_12-00
  const buildTime = new Date()
    .toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/(\d+)\/(\d+)\/(\d+),\s+/, "$3-$1-$2_")
    .replace(/:/g, "-")
    .replace(/\s+/g, "")

  const buildVars = {
    EXPO_PUBLIC_BUILD_COMMIT: gitCommit,
    EXPO_PUBLIC_BUILD_BRANCH: gitBranch,
    EXPO_PUBLIC_BUILD_USER: gitUsername,
    EXPO_PUBLIC_BUILD_TIME: buildTime,
  }

  // console.log("Build environment set:")
  // Object.entries(buildVars).forEach(([key, value]) => {
  //   console.log(`  ${key}: ${value}`)
  //   process.env[key] = value
  // })

  // Load existing .env
  const existingEnv = config().parsed || {}

  // Merge with build vars
  const updatedEnv = {...existingEnv, ...buildVars}

  // write env to process.env:
  Object.entries(updatedEnv).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`)
    process.env[key] = value
  })

  // Write back to .env
  const envContent =
    Object.entries(updatedEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"

  await writeFile(".env", envContent)

  console.log("\n.env file updated successfully")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await setBuildEnv()
}
