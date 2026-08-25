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

function requireReleaseMetadata(options) {
  if (!options.otaManifestUrl || !options.otaManifestSha256) {
    throw new Error("SDK and Engine publication requires the coordinated OTA manifest URL and SHA-256")
  }
}

export function releaseMetadataArgs({plan, otaManifestUrl, otaManifestSha256}) {
  return [
    "--family-base-version",
    plan.familyBaseVersion,
    "--release-identity",
    plan.releaseIdentity,
    "--release-set-id",
    plan.releaseSetId,
    "--source-commit",
    plan.sourceCommit,
    "--ota-manifest-url",
    otaManifestUrl,
    "--ota-manifest-sha256",
    otaManifestSha256,
  ]
}

function transitiveDependencies(family, memberName) {
  const selected = new Set()
  function visit(name) {
    const member = family.members.find((candidate) => candidate.name === name)
    if (!member) throw new Error(`Unknown release-family dependency ${name}`)
    for (const dependency of member.dependencies) {
      selected.add(dependency)
      visit(dependency)
    }
  }
  visit(memberName)
  return family.publicationOrder.filter((name) => selected.has(name))
}

function prepareBluetoothSdkBuild({rootDir, plan, otaManifestUrl, otaManifestSha256}) {
  requireReleaseMetadata({otaManifestUrl, otaManifestSha256})
  run("node", ["scripts/write-release-metadata.mjs", ...releaseMetadataArgs({plan, otaManifestUrl, otaManifestSha256})], {
    cwd: path.join(rootDir, "mobile/modules/bluetooth-sdk"),
  })
}

function prepareEngineBuild({rootDir, family, plan, otaManifestUrl, otaManifestSha256}) {
  requireReleaseMetadata({otaManifestUrl, otaManifestSha256})
  const metadataArgs = releaseMetadataArgs({plan, otaManifestUrl, otaManifestSha256})
  prepareBluetoothSdkBuild({rootDir, plan, otaManifestUrl, otaManifestSha256})

  for (const dependencyName of transitiveDependencies(family, "@mentra/engine")) {
    const dependency = family.members.find((candidate) => candidate.name === dependencyName)
    const packageDir = path.dirname(path.join(rootDir, dependency.manifest))
    const packageJson = JSON.parse(readFileSync(path.join(rootDir, dependency.manifest), "utf8"))
    if (packageJson.scripts?.build) run("bun", ["run", "build"], {cwd: packageDir})
  }

  run("node", ["scripts/write-release-metadata.mjs", ...metadataArgs], {
    cwd: path.join(rootDir, "mobile/modules/engine"),
  })
}

function verifyBluetoothSdkPackage({rootDir, plan, tarball, outputDir, otaManifestUrl, otaManifestSha256}) {
  requireReleaseMetadata({otaManifestUrl, otaManifestSha256})
  const unpacked = path.join(outputDir, "sdk-unpacked")
  mkdirSync(unpacked, {recursive: true})
  run("tar", ["-xzf", tarball, "-C", unpacked])
  run(
    "node",
    [
      "scripts/verify-release-package.mjs",
      "--package-root",
      path.join(unpacked, "package"),
      "--release-identity",
      plan.releaseIdentity,
      "--ota-manifest-url",
      otaManifestUrl,
      "--ota-manifest-sha256",
      otaManifestSha256,
    ],
    {cwd: path.join(rootDir, "mobile/modules/bluetooth-sdk")},
  )
}

function verifyEngineAndSdkPackages({
  rootDir,
  plan,
  engineTarball,
  outputDir,
  otaManifestUrl,
  otaManifestSha256,
  sdkTarball,
}) {
  requireReleaseMetadata({otaManifestUrl, otaManifestSha256})
  const engineRoot = path.join(outputDir, "engine-unpacked")
  mkdirSync(engineRoot, {recursive: true})
  run("tar", ["-xzf", engineTarball, "-C", engineRoot])
  const common = [
    "--family-base-version",
    plan.familyBaseVersion,
    "--release-identity",
    plan.releaseIdentity,
    "--release-set-id",
    plan.releaseSetId,
    "--source-commit",
    plan.sourceCommit,
    "--ota-manifest-url",
    otaManifestUrl,
    "--ota-manifest-sha256",
    otaManifestSha256,
  ]
  run("node", ["scripts/verify-release-package.mjs", "--package-root", path.join(engineRoot, "package"), ...common], {
    cwd: path.join(rootDir, "mobile/modules/engine"),
  })

  const sdkOutput = path.join(outputDir, "sdk-registry-verification")
  mkdirSync(sdkOutput, {recursive: true})
  let selectedSdkTarball = sdkTarball ? path.resolve(sdkTarball) : null
  if (!selectedSdkTarball) {
    run("npm", ["pack", `@mentra/bluetooth-sdk@${plan.releaseIdentity}`, "--pack-destination", sdkOutput], {
      cwd: rootDir,
    })
    const sdkTarballs = execFileSync("find", [sdkOutput, "-maxdepth", "1", "-name", "*.tgz", "-print"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
    if (sdkTarballs.length !== 1) throw new Error(`SDK verification produced ${sdkTarballs.length} tarballs`)
    selectedSdkTarball = sdkTarballs[0]
  }
  const sdkRoot = path.join(sdkOutput, "unpacked")
  mkdirSync(sdkRoot, {recursive: true})
  run("tar", ["-xzf", selectedSdkTarball, "-C", sdkRoot])
  run(
    "node",
    [
      "scripts/verify-release-package.mjs",
      "--package-root",
      path.join(sdkRoot, "package"),
      "--release-identity",
      plan.releaseIdentity,
      "--ota-manifest-url",
      otaManifestUrl,
      "--ota-manifest-sha256",
      otaManifestSha256,
    ],
    {cwd: path.join(rootDir, "mobile/modules/bluetooth-sdk")},
  )
}

export function publishReleaseNpm({
  rootDir,
  plan,
  memberNames,
  outputDir,
  dryRun,
  otaManifestUrl,
  otaManifestSha256,
  sdkTarball,
}) {
  requirePlanSourceCommit(rootDir, plan.sourceCommit)
  const family = loadReleaseFamily({rootDir})
  if (plan.familyBaseVersion !== family.familyBaseVersion)
    throw new Error("Release plan does not match source family base")
  const orderedNames = npmMembersInOrder(family, memberNames)
  const tag = npmReleaseTag(plan.channel)
  const publications = {}
  let selectedSdkTarball = sdkTarball
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

    if (name === "@mentra/bluetooth-sdk") {
      prepareBluetoothSdkBuild({rootDir, plan, otaManifestUrl, otaManifestSha256})
    } else if (name === "@mentra/engine") {
      prepareEngineBuild({rootDir, family, plan, otaManifestUrl, otaManifestSha256})
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

    if (name === "@mentra/bluetooth-sdk") {
      verifyBluetoothSdkPackage({
        rootDir,
        plan,
        tarball,
        outputDir: packageOutput,
        otaManifestUrl,
        otaManifestSha256,
      })
      selectedSdkTarball = tarball
    } else if (name === "@mentra/engine") {
      verifyEngineAndSdkPackages({
        rootDir,
        plan,
        engineTarball: tarball,
        outputDir: packageOutput,
        otaManifestUrl,
        otaManifestSha256,
        sdkTarball: selectedSdkTarball,
      })
    }

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
    otaManifestUrl: args["ota-manifest-url"],
    otaManifestSha256: args["ota-manifest-sha256"],
    sdkTarball: args["sdk-tarball"],
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
