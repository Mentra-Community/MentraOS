#!/usr/bin/env node
import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {requirePublicHttpsUrl} from "./release-family.mjs"

const DEFAULT_ATTEMPTS = 12
const DEFAULT_DELAY_MS = 10_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

export async function verifyPublicReleaseAsset({
  file,
  url,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("attempts must be a positive integer")
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must be non-negative")
  const publicUrl = requirePublicHttpsUrl(url, "Public release asset URL")

  const expected = readFileSync(path.resolve(file))
  let lastFailure = "not requested"

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`Verifying public release asset (attempt ${attempt}/${attempts})`)
    try {
      const response = await fetchImpl(publicUrl, {cache: "no-store", redirect: "follow"})
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`
      } else {
        const actual = Buffer.from(await response.arrayBuffer())
        if (expected.equals(actual)) return
        lastFailure = "public bytes differ from the immutable source"
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }

    if (attempt < attempts) await sleepImpl(delayMs)
  }

  throw new Error(`Public release asset did not converge after ${attempts} attempts: ${lastFailure}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file || !args.url) throw new Error("--file and --url are required")
  await verifyPublicReleaseAsset({file: args.file, url: args.url})
  console.log(`Verified public release asset ${args.url}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
