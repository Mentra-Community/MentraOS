#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = path.join(packageRoot, "package.json")
const sourcePath = path.join(packageRoot, "ios/Source/BluetoothSdkDefaults.swift")
const backupPath = path.join(packageRoot, ".bluetooth-sdk-version-prepack-backup")
const restore = process.argv.includes("--restore")

const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"))
const version = packageJson.version

if (typeof version !== "string" || version.trim() === "") {
  throw new Error("mobile/modules/bluetooth-sdk/package.json is missing a version")
}

const placeholder = 'private static let swiftPackageSdkVersion = "__MENTRA_BLUETOOTH_SDK_VERSION__"'
const injectedVersion = `private static let swiftPackageSdkVersion = "${version}"`

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

if (restore) {
  if (!(await pathExists(backupPath))) {
    console.log("No iOS SDK version prepack backup found; nothing to restore.")
    process.exit(0)
  }

  await fs.writeFile(sourcePath, await fs.readFile(backupPath, "utf8"))
  await fs.rm(backupPath)
  console.log("Restored placeholder iOS SDK version after packing.")
  process.exit(0)
}

if (await pathExists(backupPath)) {
  throw new Error("Found an existing iOS SDK version prepack backup. Run `npm run postpack` before packing again.")
}

const originalSource = await fs.readFile(sourcePath, "utf8")
let packedSource

if (originalSource.includes(placeholder)) {
  packedSource = originalSource.replace(placeholder, injectedVersion)
} else if (originalSource.includes(injectedVersion)) {
  packedSource = originalSource
} else {
  throw new Error("BluetoothSdkDefaults.swift does not contain the expected SDK version placeholder.")
}

await fs.writeFile(backupPath, originalSource)

if (packedSource !== originalSource) {
  await fs.writeFile(sourcePath, packedSource)
}

console.log(`Injected iOS SDK version ${version} for npm packaging.`)
