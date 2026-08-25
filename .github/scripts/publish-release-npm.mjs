#!/usr/bin/env node
import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {loadReleaseFamily, serializeReleaseRecord} from "./release-family.mjs"

export function npmReleaseTag(channel) {
  if (channel === "dev") return "dev"
  if (channel === "beta") return "beta"
  if (channel === "production") throw new Error("Production npm publication requires an explicit candidate dist-tag")
  throw new Error(`Unsupported npm release channel ${JSON.stringify(channel)}`)
}

export function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}

export function requirePlanSourceCommit(rootDir, expectedCommit) {
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
  if (actualCommit !== expectedCommit) {
    throw new Error(`Release source checkout is ${actualCommit}, expected ${expectedCommit}`)
  }
  return actualCommit
}

export function requireNpmProvenanceSource(packageJson, manifest) {
  const expectedDirectory = path.dirname(manifest)
  if (
    packageJson.repository?.type !== "git" ||
    packageJson.repository?.url !== "git+https://github.com/Mentra-Community/MentraOS.git" ||
    packageJson.repository?.directory !== expectedDirectory
  ) {
    throw new Error(`${packageJson.name} repository metadata does not identify ${expectedDirectory} in MentraOS`)
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

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`)
  return execFileSync(command, args, {stdio: "inherit", ...options})
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
  if (output === null) return null
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function npmViewPublished(spec, field) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const value = parseViewValue(npmView(spec, field))
    if (value !== null) return value
    if (attempt < 12) execFileSync("sleep", ["5"])
  }
  return null
}

export function npmMembersInOrder(family, selectedNames) {
  const selected = new Set(selectedNames)
  for (const name of selected) {
    const member = family.members.find((candidate) => candidate.name === name)
    if (!member) throw new Error(`Unknown release-family member ${name}`)
    if (!member.publishTargets.includes("npm")) throw new Error(`${name} is not configured for npm publication`)
  }
  return family.publicationOrder.filter((name) => selected.has(name))
}

export function publishReleaseNpm({rootDir, plan, memberNames, outputDir, dryRun}) {
  requirePlanSourceCommit(rootDir, plan.sourceCommit)
  const family = loadReleaseFamily({rootDir})
  if (plan.familyBaseVersion !== family.familyBaseVersion)
    throw new Error("Release plan does not match source family base")
  const orderedNames = npmMembersInOrder(family, memberNames)
  const tag = npmReleaseTag(plan.channel)
  const publications = {}
  mkdirSync(outputDir, {recursive: true})

  for (const name of orderedNames) {
    const member = family.members.find((candidate) => candidate.name === name)
    const packageDir = path.dirname(path.join(rootDir, member.manifest))
    const packageJson = JSON.parse(readFileSync(path.join(rootDir, member.manifest), "utf8"))
    requireNpmProvenanceSource(packageJson, member.manifest)
    if (packageJson.version !== plan.releaseIdentity) {
      throw new Error(`${name} is ${packageJson.version}, expected staged version ${plan.releaseIdentity}`)
    }
    for (const dependency of member.dependencies) {
      if (packageJson.dependencies?.[dependency] !== plan.releaseIdentity) {
        throw new Error(`${name} does not pin ${dependency} to ${plan.releaseIdentity}`)
      }
    }

    if (packageJson.scripts?.build) run("bun", ["run", "build"], {cwd: packageDir})
    const packageOutput = path.join(outputDir, name.replace(/^@/, "").replaceAll("/", "-"))
    mkdirSync(packageOutput, {recursive: true})
    run("npm", ["pack", "--pack-destination", packageOutput], {cwd: packageDir})
    const packed = execFileSync("find", [packageOutput, "-maxdepth", "1", "-name", "*.tgz", "-print"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
    if (packed.length !== 1) throw new Error(`${name} produced ${packed.length} npm tarballs`)
    const tarball = packed[0]
    const bytes = readFileSync(tarball)
    const integrity = sha512Integrity(bytes)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const coordinate = `${name}@${plan.releaseIdentity}`
    const registryIntegrity = parseViewValue(npmView(coordinate, "dist.integrity"))
    let status = "built"

    if (registryIntegrity !== null) {
      if (registryIntegrity !== integrity) {
        throw new Error(`${coordinate} already exists on npm with different bytes`)
      }
      status = "reused"
    } else if (!dryRun) {
      run("npm", ["publish", tarball, "--tag", tag, "--access", "public", "--provenance"], {cwd: rootDir})
      status = "published"
    }

    let url = `https://registry.npmjs.org/${encodeURIComponent(name)}`
    if (!dryRun) {
      const registryUrl = npmViewPublished(coordinate, "dist.tarball")
      if (typeof registryUrl !== "string" || !registryUrl.startsWith("https://")) {
        throw new Error(`${coordinate} was published but has no HTTPS registry tarball URL`)
      }
      url = registryUrl
    }
    publications[name] = {
      npm: {
        status,
        coordinate,
        url,
        sha256,
        integrity,
        provenanceUrl: `https://github.com/${process.env.GITHUB_REPOSITORY || "Mentra-Community/MentraOS"}/actions/runs/${process.env.GITHUB_RUN_ID || "0"}`,
      },
    }
  }

  const result = {releaseSetId: plan.releaseSetId, publications}
  writeFileSync(path.join(outputDir, "npm-publications.json"), serializeReleaseRecord(result))
  return result
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ["plan", "members", "output-dir"]) {
    if (!args[required]) throw new Error(`Missing --${required}`)
  }
  const rootDir = path.resolve(args.root || process.cwd())
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  publishReleaseNpm({
    rootDir,
    plan,
    memberNames: args.members.split(",").filter(Boolean),
    outputDir: path.resolve(args["output-dir"]),
    dryRun: args["dry-run"] === "true",
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
