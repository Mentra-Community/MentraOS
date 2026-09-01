import {existsSync, readFileSync} from "node:fs"
import {createHash} from "node:crypto"
import path from "node:path"

import {validateCloudV2DeploymentRecord} from "./coordinated-cloud-v2-records.mjs"
import {validateEnterpriseRuntimeDeploymentRecord} from "./coordinated-enterprise-runtime-records.mjs"

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const CHANNELS = new Set(["dev", "beta", "production"])
const KINDS = new Set(["package", "product"])
const PUBLISH_TARGETS = new Set(["app-store-connect", "google-play", "maven-central", "npm", "swift-package-manager"])
const PUBLICATION_STATUSES = new Set(["promoted", "published", "reused", "submitted"])
const SHA256_PATTERN = /^[0-9a-f]{64}$/

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

function changelogForVersion(rootDir, version) {
  const relativePath = `changelogs/${version}.md`
  const file = path.join(rootDir, relativePath)
  if (!existsSync(file)) fail(`missing ${relativePath} for the current family base version`)
  const content = readFileSync(file)
  if (content.length === 0) fail(`${relativePath} must not be empty`)
  return {
    version,
    path: relativePath,
    sha256: createHash("sha256").update(content).digest("hex"),
  }
}

function validateChangelog(changelog, familyBaseVersion) {
  if (
    changelog?.version !== familyBaseVersion ||
    changelog?.path !== `changelogs/${familyBaseVersion}.md` ||
    !SHA256_PATTERN.test(changelog?.sha256 || "")
  ) {
    throw new Error("Release plan has invalid changelog provenance")
  }
  return changelog
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
  const changelog = changelogForVersion(rootDir, familyBaseVersion)

  if (!Array.isArray(definition.members) || definition.members.length === 0) fail("members must not be empty")
  const members = []
  const names = new Set()
  const manifests = new Set()
  const packageManifests = new Map()

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
    const privateWorkspaceDependencies = rawMember.privateWorkspaceDependencies
      ? [...requireUniqueStrings(rawMember.privateWorkspaceDependencies, `${label}.privateWorkspaceDependencies`)]
      : []
    const packageManifest = readJson(path.join(rootDir, manifest))
    if (packageManifest.name !== name) {
      fail(`${manifest} declares ${JSON.stringify(packageManifest.name)}, expected ${JSON.stringify(name)}`)
    }
    if (requireVersionMirrors && packageManifest.version !== familyBaseVersion) {
      fail(`${manifest} version ${JSON.stringify(packageManifest.version)} does not mirror ${familyBaseVersion}`)
    }
    packageManifests.set(name, packageManifest)
    members.push({
      name,
      manifest,
      kind,
      publishTargets,
      dependencies,
      privateWorkspaceDependencies,
      sourceVersion: packageManifest.version,
    })
  }

  for (const member of members) {
    for (const dependency of member.dependencies) {
      if (!names.has(dependency)) fail(`${member.name} depends on unknown family member ${dependency}`)
      if (dependency === member.name) fail(`${member.name} cannot depend on itself`)
    }
  }

  if (requireVersionMirrors) {
    for (const member of members) {
      const packageManifest = packageManifests.get(member.name)
      const configuredDependencies = new Set(member.dependencies)
      const privateWorkspaceDependencies = new Set(member.privateWorkspaceDependencies)
      const expectedRange = member.name === "mentraos" ? "workspace:*" : familyBaseVersion

      for (const dependency of member.dependencies) {
        const actualRange = packageManifest.dependencies?.[dependency]
        if (actualRange !== expectedRange) {
          fail(
            `${member.manifest} dependencies.${dependency} is ${JSON.stringify(actualRange)}, expected ${JSON.stringify(expectedRange)}`,
          )
        }
      }
      for (const dependency of names) {
        if (packageManifest.peerDependencies?.[dependency] !== undefined) {
          fail(`${member.manifest} must not declare family member ${dependency} as a peerDependency`)
        }
        if (packageManifest.dependencies?.[dependency] !== undefined && !configuredDependencies.has(dependency)) {
          fail(`${member.manifest} depends on ${dependency}, but the release-family graph is missing that edge`)
        }
      }
      for (const dependency of Object.keys(packageManifest.dependencies || {})) {
        if (
          dependency.startsWith("@mentra/") &&
          !names.has(dependency) &&
          !privateWorkspaceDependencies.has(dependency)
        ) {
          fail(
            `${member.manifest} depends on unclassified first-party package ${dependency}; add it to the release family or privateWorkspaceDependencies`,
          )
        }
      }
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
    changelog,
    products,
    members,
    publicationOrder,
  }
}

export function createReleasePlan({
  family,
  channel,
  sequence,
  sourceCommit,
  nativeBuildNumber,
  otaInputs = {},
  starterKitSource,
}) {
  if (!family?.members || !family?.familyBaseVersion) throw new Error("A validated release family is required")
  const changelog = validateChangelog(family.changelog, family.familyBaseVersion)
  if (!CHANNELS.has(channel)) throw new Error(`Unknown release channel ${JSON.stringify(channel)}`)
  if (typeof sourceCommit !== "string" || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("sourceCommit must be a full lowercase Git commit SHA")
  }
  if (!Number.isSafeInteger(nativeBuildNumber) || nativeBuildNumber < 1) {
    throw new Error("nativeBuildNumber must be a positive safe integer")
  }

  const releaseIdentity = deriveReleaseIdentity(family.familyBaseVersion, channel, sequence)
  if (starterKitSource !== undefined) {
    const expectedBranch = channel === "dev" ? "dev" : channel === "beta" ? "staging" : "main"
    if (
      starterKitSource.repository !== "Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit" ||
      starterKitSource.branch !== expectedBranch ||
      !COMMIT_PATTERN.test(starterKitSource.sourceCommit || "")
    ) {
      throw new Error("starterKitSource must identify the exact channel branch and commit")
    }
  }
  const members = Object.fromEntries(
    family.members.map((member) => [
      member.name,
      {
        version: releaseIdentity,
        kind: member.kind,
        manifest: member.manifest,
        publishTargets: member.publishTargets,
        dependencies: Object.fromEntries(member.dependencies.map((dependency) => [dependency, releaseIdentity])),
        privateWorkspaceDependencies: member.privateWorkspaceDependencies,
      },
    ]),
  )

  return {
    schemaVersion: 1,
    releaseSetId: releaseSetId(releaseIdentity),
    familyBaseVersion: family.familyBaseVersion,
    changelog: {...changelog},
    releaseIdentity,
    artifactContainerTag:
      channel === "production" ? `mentra-v${releaseIdentity}` : `mentra-builds-v${family.familyBaseVersion}`,
    artifactContainerName:
      channel === "production" ? `Mentra ${releaseIdentity}` : `Mentra ${family.familyBaseVersion} development builds`,
    channel,
    sequence: channel === "production" ? null : sequence,
    sourceCommit,
    native: {
      marketingVersion: family.familyBaseVersion,
      buildNumber: nativeBuildNumber,
    },
    products: Object.fromEntries(family.products.map((product) => [product, releaseIdentity])),
    members,
    publicationOrder: family.publicationOrder,
    ...(starterKitSource ? {starterKitSource: {...starterKitSource}} : {}),
    artifactNames: {
      releasePlan: `mentra-release-plan-${releaseIdentity}.json`,
      releaseManifest: `mentra-release-${releaseIdentity}.json`,
      otaManifest: `mentra-live-ota-${releaseIdentity}.json`,
      otaBundle: `mentra-live-ota-bundle-${releaseIdentity}.zip`,
      asgSelection: `mentra-live-asg-selection-${releaseIdentity}.json`,
      androidApp: `mentraos-${releaseIdentity}-android.apk`,
      androidStoreApp: `mentraos-${releaseIdentity}-android.aab`,
      iosApp: `mentraos-${releaseIdentity}-ios.ipa`,
      iosSdkArchive: `mentra-bluetooth-sdk-ios-${releaseIdentity}.tar`,
      enginePackage: `mentra-engine-${releaseIdentity}.tgz`,
    },
    otaInputs,
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function serializeReleaseRecord(record) {
  return `${JSON.stringify(canonicalize(record), null, 2)}\n`
}

export function releaseRecordSha256(record) {
  return createHash("sha256").update(serializeReleaseRecord(record)).digest("hex")
}

export function requirePublicHttpsUrl(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`)
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`)
  }
  return parsed.toString()
}

function validatePublication(publication, label) {
  if (!publication || typeof publication !== "object") throw new Error(`${label} is missing`)
  if (!PUBLICATION_STATUSES.has(publication.status)) {
    throw new Error(`${label}.status must be promoted, published, reused, or submitted`)
  }
  requireString(publication.coordinate, `${label}.coordinate`)
  requirePublicHttpsUrl(publication.url, `${label}.url`)
  requirePublicHttpsUrl(publication.provenanceUrl, `${label}.provenanceUrl`)
  if (!SHA256_PATTERN.test(publication.sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`)
  }
  return publication
}

function expectedPublicationCoordinate(plan, memberName, target) {
  const version = plan.members[memberName].version
  if (target === "npm") return `${memberName}@${version}`
  if (target === "maven-central") return `com.mentraglass:bluetooth-sdk:${version}`
  if (target === "swift-package-manager") return `Mentra-Community/mentra-bluetooth-sdk-ios@${version}`
  const channels = {
    dev: {play: "internal", appStore: "Mentra Dev"},
    beta: {play: "beta", appStore: "Mentra Staging"},
    production: {play: "production", appStore: "App Store"},
  }
  const selected = channels[plan.channel]
  if (!selected) throw new Error(`Unknown release channel ${JSON.stringify(plan.channel)}`)
  if (target === "google-play") return `com.mentra.mentra:${plan.native.buildNumber}:${selected.play}`
  if (target === "app-store-connect") {
    return `com.mentra.mentra:${plan.native.marketingVersion}:${plan.native.buildNumber}:${selected.appStore}`
  }
  throw new Error(`Unknown publication target ${JSON.stringify(target)}`)
}

function requiredArtifactCoordinates(plan) {
  const keys =
    plan.channel === "production"
      ? ["enginePackage"]
      : ["otaBundle", "asgSelection", "androidApp", "androidStoreApp", "iosApp", "enginePackage"]
  return keys.map((key) => {
    const coordinate = plan.artifactNames?.[key]
    if (typeof coordinate !== "string" || coordinate.length === 0) {
      throw new Error(`Release plan is missing required artifact name ${key}`)
    }
    return coordinate
  })
}

function validateStarterKitEvidence(plan, starterKit, artifacts) {
  if (starterKit === undefined) return undefined
  if (
    starterKit?.schemaVersion !== 1 ||
    starterKit.releaseSetId !== plan.releaseSetId ||
    starterKit.releaseIdentity !== plan.releaseIdentity ||
    starterKit.familyBaseVersion !== plan.familyBaseVersion ||
    starterKit.channel !== plan.channel ||
    starterKit.mentraos?.sourceCommit !== plan.sourceCommit ||
    (plan.starterKitSource && starterKit.starterKit?.baseCommit !== plan.starterKitSource.sourceCommit) ||
    !Array.isArray(starterKit.artifacts) ||
    ![3, 4].includes(starterKit.artifacts.length)
  ) {
    throw new Error("Starter Kit evidence does not match the release plan")
  }
  requirePublicHttpsUrl(starterKit.resultUrl, "starterKit.resultUrl")
  requirePublicHttpsUrl(starterKit.starterKit?.releaseUrl, "starterKit.starterKit.releaseUrl")
  requirePublicHttpsUrl(starterKit.starterKit?.pullRequestUrl, "starterKit.starterKit.pullRequestUrl")
  requirePublicHttpsUrl(starterKit.starterKit?.validationRunUrl, "starterKit.starterKit.validationRunUrl")

  const artifactByCoordinate = new Map(artifacts.map((artifact) => [artifact.coordinate, artifact]))
  for (const example of starterKit.artifacts) {
    const artifact = artifactByCoordinate.get(example.name)
    if (
      !artifact ||
      artifact.url !== example.url ||
      artifact.sha256 !== example.sha256 ||
      artifact.size !== example.size
    ) {
      throw new Error(`Starter Kit artifact ${example.name || "<unknown>"} differs from publication evidence`)
    }
  }
  const expectedGroup = plan.channel === "dev" ? "Mentra Dev" : "Mentra Staging Public"
  const expectedAudience = plan.channel === "dev" ? "internal" : "external"
  const testflight = starterKit.testflight
  if (
    testflight?.schemaVersion !== 1 ||
    testflight.releaseSetId !== plan.releaseSetId ||
    testflight.releaseIdentity !== plan.releaseIdentity ||
    testflight.channel !== plan.channel ||
    testflight.mentraosSourceCommit !== plan.sourceCommit ||
    testflight.starterKitReleaseCommit !== starterKit.starterKit?.releaseCommit ||
    testflight.app?.id !== "6792839366" ||
    testflight.app?.bundleId !== "com.mentra.bluetoothsdkexample" ||
    testflight.version?.marketingVersion !== plan.native.marketingVersion ||
    testflight.version?.buildNumber !== plan.native.buildNumber ||
    testflight.build?.processingState !== "VALID" ||
    !["published", "reused"].includes(testflight.build?.uploadStatus) ||
    typeof testflight.build?.id !== "string" ||
    testflight.build.id.length === 0 ||
    testflight.group?.name !== expectedGroup ||
    typeof testflight.group?.id !== "string" ||
    testflight.group.id.length === 0 ||
    testflight.distribution?.audience !== expectedAudience ||
    !["available", "submitted", "skipped"].includes(testflight.distribution?.status) ||
    !/^https:\/\//.test(testflight.distribution?.installUrl || "")
  ) {
    throw new Error("Starter Kit TestFlight evidence does not match the release plan")
  }
  if (plan.channel === "dev" && testflight.distribution.status !== "available") {
    throw new Error("Internal Starter Kit TestFlight distribution must be available")
  }
  if (
    expectedAudience === "external" &&
    !/^https:\/\/testflight\.apple\.com\/join\//.test(testflight.distribution.installUrl)
  ) {
    throw new Error("External Starter Kit TestFlight distribution must use a public invitation link")
  }
  if (testflight.distribution.status === "skipped" && !testflight.distribution.skipReason) {
    throw new Error("Skipped Starter Kit TestFlight distribution must identify its reason")
  }
  if (
    testflight.ipa !== undefined &&
    (!SHA256_PATTERN.test(testflight.ipa.sha256 || "") ||
      !Number.isSafeInteger(testflight.ipa.size) ||
      testflight.ipa.size < 1)
  ) {
    throw new Error("Starter Kit TestFlight IPA evidence is invalid")
  }
  requirePublicHttpsUrl(testflight.provenanceUrl, "starterKit.testflight.provenanceUrl")
  return starterKit
}

function validateProductionExampleTestflight(plan, testflight) {
  if (plan.channel !== "production") return undefined
  if (
    testflight?.schemaVersion !== 1 ||
    testflight.releaseSetId !== plan.releaseSetId ||
    testflight.releaseIdentity !== plan.releaseIdentity ||
    testflight.channel !== "production" ||
    testflight.selectedBetaReleaseSetId !== plan.promotion?.selectedBetaReleaseSetId ||
    testflight.selectedBetaIdentity !== plan.promotion?.selectedBetaIdentity ||
    testflight.app?.id !== "6792839366" ||
    testflight.app?.bundleId !== "com.mentra.bluetoothsdkexample" ||
    testflight.version?.marketingVersion !== plan.native?.marketingVersion ||
    testflight.version?.buildNumber !== plan.native?.buildNumber ||
    testflight.build?.processingState !== "VALID" ||
    testflight.group?.name !== "Mentra Production Public" ||
    testflight.distribution?.audience !== "external" ||
    testflight.distribution?.status !== "available" ||
    testflight.distribution?.reviewState !== "APPROVED"
  ) {
    throw new Error("Production example TestFlight evidence does not match the release plan")
  }
  requireString(testflight.build.id, "exampleTestflight.build.id")
  requireString(testflight.group.id, "exampleTestflight.group.id")
  requirePublicHttpsUrl(
    testflight.build.sourceTestflightProvenanceUrl,
    "exampleTestflight.build.sourceTestflightProvenanceUrl",
  )
  requirePublicHttpsUrl(testflight.provenanceUrl, "exampleTestflight.provenanceUrl")
  if (!/^https:\/\/testflight\.apple\.com\/join\//.test(testflight.distribution.installUrl || "")) {
    throw new Error("Production example TestFlight distribution must use a public invitation link")
  }
  return testflight
}

export function finalizeReleaseManifest({plan, results, completedAt}) {
  if (!plan?.releaseSetId || !plan?.members) throw new Error("A generated release plan is required")
  if (results?.releaseSetId !== plan.releaseSetId) throw new Error("Publication results do not match the release set")
  const completed = new Date(completedAt)
  if (!completedAt || Number.isNaN(completed.valueOf()) || completed.toISOString() !== completedAt) {
    throw new Error("completedAt must be an ISO-8601 UTC timestamp")
  }
  if (
    plan.native?.marketingVersion !== plan.familyBaseVersion ||
    !Number.isSafeInteger(plan.native?.buildNumber) ||
    plan.native.buildNumber < 1
  ) {
    throw new Error("Release plan has invalid native build identity")
  }
  const changelog = validateChangelog(plan.changelog, plan.familyBaseVersion)

  const publications = {}
  for (const [memberName, member] of Object.entries(plan.members)) {
    const memberResults = results.publications?.[memberName]
    if (!memberResults || typeof memberResults !== "object") {
      throw new Error(`Missing publication results for ${memberName}`)
    }
    publications[memberName] = {}
    for (const target of member.publishTargets) {
      const label = `publications.${memberName}.${target}`
      const publication = validatePublication(memberResults[target], label)
      const expected = expectedPublicationCoordinate(plan, memberName, target)
      if (publication.coordinate !== expected) {
        throw new Error(`${label}.coordinate must be ${expected}`)
      }
      publications[memberName][target] = publication
    }
  }

  const otaManifest = validatePublication(results.otaManifest, "otaManifest")
  if (plan.channel === "production" && otaManifest.status !== "promoted") {
    throw new Error("Production OTA manifest must be promoted from the selected beta")
  }
  if (plan.channel !== "production" && otaManifest.coordinate !== plan.artifactNames.otaManifest) {
    throw new Error(`otaManifest.coordinate must be ${plan.artifactNames.otaManifest}`)
  }
  if (!Array.isArray(results.artifacts)) throw new Error("artifacts must be an array")
  const artifacts = results.artifacts.map((artifact, index) => validatePublication(artifact, `artifacts[${index}]`))
  const artifactCoordinates = new Set()
  for (const artifact of artifacts) {
    if (artifactCoordinates.has(artifact.coordinate)) {
      throw new Error(`artifacts contains duplicate coordinate ${artifact.coordinate}`)
    }
    artifactCoordinates.add(artifact.coordinate)
  }
  for (const coordinate of requiredArtifactCoordinates(plan)) {
    if (!artifactCoordinates.has(coordinate)) throw new Error(`Missing required artifact ${coordinate}`)
  }
  const starterKit = validateStarterKitEvidence(plan, results.starterKit, artifacts)
  const exampleTestflight = validateProductionExampleTestflight(plan, results.exampleTestflight)
  const cloud = validateCloudV2DeploymentRecord({plan, record: results.cloud})
  const enterpriseRuntime =
    plan.channel === "dev"
      ? validateEnterpriseRuntimeDeploymentRecord({plan, record: results.enterpriseRuntime})
      : undefined

  let promotion
  if (plan.channel === "production") {
    promotion = results.promotion
    if (
      !promotion ||
      promotion.selectedBetaReleaseSetId !== plan.promotion?.selectedBetaReleaseSetId ||
      promotion.selectedBetaIdentity !== plan.promotion?.selectedBetaIdentity ||
      promotion.selectedBetaManifest?.url !== plan.promotion?.selectedBetaManifest?.url ||
      promotion.selectedBetaManifest?.sha256 !== plan.promotion?.selectedBetaManifest?.sha256
    ) {
      throw new Error("Production release is missing its exact selected beta provenance")
    }
    requirePublicHttpsUrl(promotion.selectedBetaManifest.url, "promotion.selectedBetaManifest.url")
    if (!SHA256_PATTERN.test(promotion.selectedBetaManifest.sha256)) {
      throw new Error("promotion.selectedBetaManifest.sha256 must be a lowercase SHA-256 digest")
    }
  }

  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    familyBaseVersion: plan.familyBaseVersion,
    changelog,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    sourceCommit: plan.sourceCommit,
    native: plan.native,
    completedAt,
    releasePlanSha256: releaseRecordSha256(plan),
    publications,
    otaManifest,
    artifacts,
    cloud,
    ...(enterpriseRuntime ? {enterpriseRuntime} : {}),
    ...(starterKit ? {starterKit} : {}),
    ...(exampleTestflight ? {exampleTestflight} : {}),
    ...(promotion ? {promotion} : {}),
  }
}
