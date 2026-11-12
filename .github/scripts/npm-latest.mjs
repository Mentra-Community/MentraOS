#!/usr/bin/env node
// Check npm `latest` around the release phase of a production package run.
//
// The release phase publishes each plain X.Y.Z straight to `latest` through
// trusted publishing (OIDC), as the dev and beta channels publish to `dev` and
// `beta`. Nothing is published to npm before that protected phase, and no
// dist-tag is ever moved. A move would need either a 2FA-bypassing token, which
// npm is retiring (the production token was refused outright on 3.3.0, run
// 41238528830), or the trusted publisher's "Allow npm dist-tag" permission,
// which is set per package on npmjs.com and works only on GitHub-hosted
// runners. Publishing straight to `latest` needs neither.
//
// preflight runs before anything public changes. Every member must be either
// unpublished with `latest` not ahead of X.Y.Z, or already published with
// `latest` at X.Y.Z (a rerun). verify runs after the publish and waits for npm
// to serve `latest` at X.Y.Z, with the published bytes, for every member.
import {execFileSync} from "node:child_process"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function compareVersions(left, right) {
  const a = VERSION_PATTERN.exec(left || "")
  const b = VERSION_PATTERN.exec(right || "")
  if (!a || !b) throw new Error(`Cannot compare npm versions ${JSON.stringify(left)} and ${JSON.stringify(right)}`)
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference !== 0) return Math.sign(difference)
  }
  if (a[4] === b[4]) return 0
  if (a[4] === undefined) return 1
  if (b[4] === undefined) return -1
  return a[4] < b[4] ? -1 : 1
}

export function latestDecision({coordinate, version, published, distTags}) {
  const latest = distTags?.latest ?? null
  if (published && latest === version) return {action: "reused", previousLatest: version}
  // A newer release owns latest: never publish over it or move it back.
  if (latest && compareVersions(latest, version) > 0) {
    throw new Error(`latest already points at the newer version ${latest}; refusing to release ${coordinate} over it`)
  }
  if (published) {
    // Publishing with `--tag latest` sets the tag with the version, so this is
    // a version published some other way. Only a maintainer can move the tag.
    throw new Error(
      `${coordinate} is on npm but latest points at ${JSON.stringify(latest)}; a maintainer must run ` +
        `\`npm dist-tag add ${coordinate} latest\` with 2FA before this phase can continue`,
    )
  }
  return {action: "publish", previousLatest: latest}
}

export function npmMembersFromPlan(plan) {
  if (!Array.isArray(plan?.publicationOrder) || !plan?.members) throw new Error("A release plan is required")
  return plan.publicationOrder.filter((name) => plan.members[name]?.publishTargets?.includes("npm"))
}

function npmView(spec, field) {
  try {
    return execFileSync("npm", ["view", spec, field, "--json", "--registry=https://registry.npmjs.org"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`
    if (/"code":\s*"E404"/.test(output) || /code E404/.test(output)) return null
    throw new Error(`npm view ${spec} failed with a non-404 error:\n${output}`)
  }
}

function parseViewValue(output) {
  if (output === null || output === "") return null
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function requireProductionPlan(plan) {
  if (plan?.channel !== "production") throw new Error("Only a production plan publishes npm latest")
  return plan.releaseIdentity
}

// Decide for the whole family before anything is published, so a member that
// is already ahead, or published without `latest`, stops the run with nothing
// public changed.
export function preflightNpmLatest({plan, outputDir, view = npmView}) {
  const version = requireProductionPlan(plan)
  const members = {}
  for (const name of npmMembersFromPlan(plan)) {
    const coordinate = `${name}@${version}`
    const integrity = parseViewValue(view(coordinate, "dist.integrity"))
    const distTags = parseViewValue(view(name, "dist-tags")) || {}
    members[name] = latestDecision({coordinate, version, published: integrity !== null, distTags})
  }
  const result = {schemaVersion: 1, releaseSetId: plan.releaseSetId, releaseIdentity: version, members}
  if (outputDir) {
    mkdirSync(outputDir, {recursive: true})
    writeFileSync(path.join(outputDir, "npm-preflight.json"), serializeReleaseRecord(result))
  }
  return result
}

// npm acknowledges a publish before every read path serves its dist-tags: the
// first read-back after a dist-tag change could still return the previous
// latest (seen on the first 3.1.0 release). Poll for a bounded time before
// concluding that `latest` did not move.
export const NPM_TAG_READBACK_POLL_SECONDS = 5
export const NPM_TAG_READBACK_ATTEMPTS = 61 // five minutes

export function verifyNpmLatest({
  plan,
  preflight,
  publications,
  outputDir,
  view = npmView,
  log = console.log,
  readbackAttempts = NPM_TAG_READBACK_ATTEMPTS,
  sleep = () => execFileSync("sleep", [String(NPM_TAG_READBACK_POLL_SECONDS)]),
}) {
  const version = requireProductionPlan(plan)
  if (preflight?.releaseSetId !== plan.releaseSetId || publications?.releaseSetId !== plan.releaseSetId) {
    throw new Error("npm preflight and publication records must belong to the release plan")
  }
  const result = {schemaVersion: 1, releaseSetId: plan.releaseSetId, releaseIdentity: version, publications: {}}
  for (const name of npmMembersFromPlan(plan)) {
    const coordinate = `${name}@${version}`
    const published = publications.publications?.[name]?.npm
    if (!published || published.coordinate !== coordinate || !["published", "reused"].includes(published.status)) {
      throw new Error(`${coordinate} has no publication record from this run`)
    }
    for (let attempt = 1; ; attempt += 1) {
      const latest = (parseViewValue(view(name, "dist-tags")) || {}).latest ?? null
      if (latest === version) break
      if (attempt >= readbackAttempts) {
        const waited = (attempt - 1) * NPM_TAG_READBACK_POLL_SECONDS
        throw new Error(`${name} latest reads back as ${JSON.stringify(latest)} after ${waited}s, expected ${version}`)
      }
      if (attempt === 1 || attempt % 12 === 0) {
        log(`${name} latest still reads back as ${JSON.stringify(latest)}; waiting for npm`)
      }
      sleep()
    }
    const integrity = parseViewValue(view(coordinate, "dist.integrity"))
    if (integrity !== published.integrity) {
      throw new Error(
        `${coordinate} is served with ${JSON.stringify(integrity)}, not the published ${published.integrity}`,
      )
    }
    result.publications[name] = {
      npm: {
        status: published.status,
        coordinate,
        tag: "latest",
        previousLatest: preflight.members?.[name]?.previousLatest ?? null,
        integrity,
        url: `https://www.npmjs.com/package/${name}/v/${version}`,
        provenanceUrl: published.provenanceUrl,
      },
    }
  }
  if (outputDir) {
    mkdirSync(outputDir, {recursive: true})
    writeFileSync(path.join(outputDir, "npm-latest.json"), serializeReleaseRecord(result))
  }
  return result
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

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  for (const required of ["plan", "output-dir"]) {
    if (!args[required]) throw new Error(`Missing --${required}`)
  }
  const plan = readJson(args.plan)
  const outputDir = path.resolve(args["output-dir"])
  if (command === "preflight") {
    preflightNpmLatest({plan, outputDir})
    return
  }
  if (command === "verify") {
    for (const required of ["preflight", "publications"]) {
      if (!args[required]) throw new Error(`Missing --${required}`)
    }
    verifyNpmLatest({plan, preflight: readJson(args.preflight), publications: readJson(args.publications), outputDir})
    return
  }
  throw new Error(`Unknown npm latest command ${JSON.stringify(command)}; expected preflight or verify`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
