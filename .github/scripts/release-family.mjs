import {readFileSync} from "node:fs"
import path from "node:path"

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const CHANNELS = new Set(["dev", "beta", "production"])
const KINDS = new Set(["package", "product"])
const PUBLISH_TARGETS = new Set(["app-store-connect", "google-play", "maven-central", "npm", "swift-package-manager"])

function fail(message) {
  throw new Error(`Invalid release family: ${message}`)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`Could not read JSON from ${file}: ${error.message}`)
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function requireUniqueStrings(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`)
  const seen = new Set()
  for (const value of values) {
    requireString(value, `${label} entry`)
    if (seen.has(value)) fail(`${label} contains duplicate ${value}`)
    seen.add(value)
  }
  return seen
}

export function validateFamilyBaseVersion(version) {
  if (typeof version !== "string" || !STABLE_VERSION_PATTERN.test(version)) {
    fail(`family base version ${JSON.stringify(version)} must be a plain X.Y.Z version`)
  }
  return version
}

export function channelForBranch(branch) {
  if (branch === "dev") return "dev"
  if (branch === "staging") return "beta"
  if (branch === "main") return "production"
  throw new Error(`Branch ${JSON.stringify(branch)} is not a coordinated release branch`)
}

export function deriveReleaseIdentity(familyBaseVersion, channel, sequence) {
  validateFamilyBaseVersion(familyBaseVersion)
  if (!CHANNELS.has(channel)) throw new Error(`Unknown release channel ${JSON.stringify(channel)}`)

  if (channel === "production") {
    if (sequence !== undefined && sequence !== null) {
      throw new Error("Production release identities do not accept a prerelease sequence")
    }
    return familyBaseVersion
  }

  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`${channel} release sequence must be a positive safe integer`)
  }
  return `${familyBaseVersion}-${channel}.${sequence}`
}

export function releaseSetId(releaseIdentity) {
  return `mentra-${releaseIdentity}`
}

export function dependencyOrder(members) {
  const byName = new Map(members.map((member) => [member.name, member]))
  const permanent = new Set()
  const temporary = new Set()
  const ordered = []

  function visit(name, trail = []) {
    if (permanent.has(name)) return
    if (temporary.has(name)) fail(`dependency cycle: ${[...trail, name].join(" -> ")}`)
    const member = byName.get(name)
    if (!member) fail(`dependency graph references unknown member ${name}`)
    temporary.add(name)
    for (const dependency of member.dependencies) visit(dependency, [...trail, name])
    temporary.delete(name)
    permanent.add(name)
    ordered.push(name)
  }

  for (const member of members) visit(member.name)
  return ordered
}

export function loadReleaseFamily({rootDir = process.cwd(), requireVersionMirrors = false} = {}) {
  const definitionPath = path.join(rootDir, ".github/release-family.json")
  const definition = readJson(definitionPath)
  if (definition.schemaVersion !== 1) fail(`unsupported schemaVersion ${JSON.stringify(definition.schemaVersion)}`)
  requireString(definition.family, "family")
  const versionSource = requireString(definition.versionSource, "versionSource")
  const familyBaseVersion = validateFamilyBaseVersion(readJson(path.join(rootDir, versionSource)).version)

  if (!Array.isArray(definition.members) || definition.members.length === 0) fail("members must not be empty")
  const members = []
  const names = new Set()
  const manifests = new Set()

  for (const [index, rawMember] of definition.members.entries()) {
    const label = `members[${index}]`
    const name = requireString(rawMember?.name, `${label}.name`)
    const manifest = requireString(rawMember?.manifest, `${label}.manifest`)
    const kind = requireString(rawMember?.kind, `${label}.kind`)
    if (!KINDS.has(kind)) fail(`${label}.kind ${JSON.stringify(kind)} is unsupported`)
    if (names.has(name)) fail(`duplicate member name ${name}`)
    if (manifests.has(manifest)) fail(`duplicate member manifest ${manifest}`)
    names.add(name)
    manifests.add(manifest)

    const publishTargets = [...requireUniqueStrings(rawMember.publishTargets, `${label}.publishTargets`)]
    for (const target of publishTargets) {
      if (!PUBLISH_TARGETS.has(target)) fail(`${label}.publishTargets contains unsupported target ${target}`)
    }
    const dependencies = [...requireUniqueStrings(rawMember.dependencies, `${label}.dependencies`)]
    const packageManifest = readJson(path.join(rootDir, manifest))
    if (packageManifest.name !== name) {
      fail(`${manifest} declares ${JSON.stringify(packageManifest.name)}, expected ${JSON.stringify(name)}`)
    }
    if (requireVersionMirrors && packageManifest.version !== familyBaseVersion) {
      fail(`${manifest} version ${JSON.stringify(packageManifest.version)} does not mirror ${familyBaseVersion}`)
    }
    members.push({name, manifest, kind, publishTargets, dependencies, sourceVersion: packageManifest.version})
  }

  for (const member of members) {
    for (const dependency of member.dependencies) {
      if (!names.has(dependency)) fail(`${member.name} depends on unknown family member ${dependency}`)
      if (dependency === member.name) fail(`${member.name} cannot depend on itself`)
    }
  }

  const products = [...requireUniqueStrings(definition.products, "products")]
  for (const product of products) {
    const member = members.find((candidate) => candidate.name === product)
    if (!member) fail(`products contains unknown family member ${product}`)
    if (member.kind !== "product") fail(`${product} is listed as a product but has kind ${member.kind}`)
  }
  const productSet = new Set(products)
  for (const member of members) {
    if (member.kind === "product" && !productSet.has(member.name))
      fail(`${member.name} has kind product but is not listed in products`)
  }

  const publicationOrder = dependencyOrder(members)
  return {
    schemaVersion: definition.schemaVersion,
    family: definition.family,
    familyBaseVersion,
    versionSource,
    products,
    members,
    publicationOrder,
  }
}

export function createReleasePlan({family, channel, sequence, sourceCommit, nativeBuildNumber, otaInputs = {}}) {
  if (!family?.members || !family?.familyBaseVersion) throw new Error("A validated release family is required")
  if (!CHANNELS.has(channel)) throw new Error(`Unknown release channel ${JSON.stringify(channel)}`)
  if (typeof sourceCommit !== "string" || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("sourceCommit must be a full lowercase Git commit SHA")
  }
  if (!Number.isSafeInteger(nativeBuildNumber) || nativeBuildNumber < 1) {
    throw new Error("nativeBuildNumber must be a positive safe integer")
  }

  const releaseIdentity = deriveReleaseIdentity(family.familyBaseVersion, channel, sequence)
  const products = Object.fromEntries(family.members.map((member) => [member.name, releaseIdentity]))
  const dependencies = Object.fromEntries(
    family.members.map((member) => [
      member.name,
      Object.fromEntries(member.dependencies.map((dependency) => [dependency, releaseIdentity])),
    ]),
  )

  return {
    schemaVersion: 1,
    releaseSetId: releaseSetId(releaseIdentity),
    familyBaseVersion: family.familyBaseVersion,
    releaseIdentity,
    channel,
    sequence: channel === "production" ? null : sequence,
    sourceCommit,
    native: {
      marketingVersion: family.familyBaseVersion,
      buildNumber: nativeBuildNumber,
    },
    products,
    dependencies,
    publicationOrder: family.publicationOrder,
    otaInputs,
  }
}
