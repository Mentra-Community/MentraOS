#!/usr/bin/env node
// Flip the npm `latest` dist-tag to the plain versions a production package run
// already published under its candidate dist-tag.
//
// publish-release-npm.mjs refuses to publish a production plan straight to
// `latest`: the stable run publishes X.Y.Z under `candidate-X.Y.Z` first, a
// human approves the protected release phase, and only then does this script
// move `latest`. Moving a dist-tag needs a real npm token (NODE_AUTH_TOKEN);
// trusted-publisher OIDC only covers `npm publish`.
import {execFileSync} from "node:child_process"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {resolveNpmReleaseTag} from "./publish-release-npm.mjs"
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

export function latestFlipDecision({version, candidateTag, distTags}) {
  const tags = distTags || {}
  if (tags.latest === version) return {action: "reused", previousLatest: version}
  if (tags[candidateTag] !== version) {
    throw new Error(
      `${candidateTag} points at ${JSON.stringify(tags[candidateTag] ?? null)}, not ${version}; run the publish phase first`,
    )
  }
  if (tags.latest && compareVersions(tags.latest, version) > 0) {
    throw new Error(`latest already points at the newer version ${tags.latest}; refusing to move it back to ${version}`)
  }
  return {action: "published", previousLatest: tags.latest ?? null}
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

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`)
  execFileSync(command, args, {stdio: "inherit"})
}

// npm acknowledges a dist-tag change before every read path serves it: the
// first read-back after `npm dist-tag add` can still return the previous
// latest (seen on the first 3.1.0 release, where the tag had moved but the
// read-back failed the run). Poll for a bounded time before concluding that
// the move did not take.
export const NPM_TAG_READBACK_POLL_SECONDS = 5
export const NPM_TAG_READBACK_ATTEMPTS = 61 // five minutes

export function promoteNpmLatest({
  plan,
  npmTag,
  outputDir,
  dryRun = false,
  view = npmView,
  exec = run,
  log = console.log,
  readbackAttempts = NPM_TAG_READBACK_ATTEMPTS,
  sleep = () => execFileSync("sleep", [String(NPM_TAG_READBACK_POLL_SECONDS)]),
}) {
  if (plan?.channel !== "production") throw new Error("Only a production plan can move npm latest")
  const version = plan.releaseIdentity
  const candidateTag = resolveNpmReleaseTag(plan.channel, npmTag)

  // Decide for the whole family before touching any dist-tag, so a member that
  // is unpublished or already ahead stops the run with nothing moved.
  const planned = npmMembersFromPlan(plan).map((name) => {
    const coordinate = `${name}@${version}`
    const integrity = parseViewValue(view(coordinate, "dist.integrity"))
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      throw new Error(`${coordinate} is not published on npm; run the publish phase first`)
    }
    const distTags = parseViewValue(view(name, "dist-tags")) || {}
    return {name, coordinate, integrity, decision: latestFlipDecision({version, candidateTag, distTags})}
  })

  const publications = {}
  for (const {name, coordinate, integrity, decision} of planned) {
    let status = decision.action
    if (decision.action === "published" && dryRun) {
      status = "built"
      log(`Dry run: would move ${name} latest from ${decision.previousLatest ?? "<unset>"} to ${version}`)
    } else if (decision.action === "published") {
      exec("npm", ["dist-tag", "add", coordinate, "latest"])
      for (let attempt = 1; ; attempt += 1) {
        const observed = parseViewValue(view(name, "dist-tags")) || {}
        if (observed.latest === version) break
        if (attempt >= readbackAttempts) {
          const waited = (attempt - 1) * NPM_TAG_READBACK_POLL_SECONDS
          throw new Error(
            `${name} latest reads back as ${JSON.stringify(observed.latest ?? null)} after ${waited}s, expected ${version}`,
          )
        }
        if (attempt === 1 || attempt % 12 === 0) {
          log(`${name} latest still reads back as ${JSON.stringify(observed.latest ?? null)}; waiting for npm`)
        }
        sleep()
      }
    }
    if (!dryRun) {
      const current = parseViewValue(view(name, "dist-tags")) || {}
      if (current[candidateTag] === version) exec("npm", ["dist-tag", "rm", name, candidateTag])
    }
    publications[name] = {
      npm: {
        status,
        coordinate,
        tag: "latest",
        candidateTag,
        previousLatest: decision.previousLatest,
        integrity,
        url: `https://www.npmjs.com/package/${name}/v/${version}`,
        provenanceUrl: `https://github.com/${process.env.GITHUB_REPOSITORY || "Mentra-Community/MentraOS"}/actions/runs/${process.env.GITHUB_RUN_ID || "0"}`,
      },
    }
  }
  const result = {schemaVersion: 1, releaseSetId: plan.releaseSetId, releaseIdentity: version, publications}
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

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ["plan", "npm-tag", "output-dir"]) {
    if (!args[required]) throw new Error(`Missing --${required}`)
  }
  promoteNpmLatest({
    plan: JSON.parse(readFileSync(path.resolve(args.plan), "utf8")),
    npmTag: args["npm-tag"],
    outputDir: path.resolve(args["output-dir"]),
    dryRun: args["dry-run"] === "true",
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
