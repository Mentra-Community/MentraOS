#!/usr/bin/env node
// Exports the Bluetooth SDK Starter Kit from examples/bluetooth.
//
// In MentraOS the examples build against the SDK source: the React Native
// examples are members of the examples/ Bun workspace (`workspace:*`), the
// native Android example includes the SDK as a Gradle composite build, and
// the Apple examples use the SDK as a local Swift package. The standalone
// Starter Kit is the same tree with every SDK reference pinned to the
// packages one completed release published, so a developer can clone it and
// start coding without a MentraOS checkout.
//
// The release bill of materials (mentra-release-<identity>.json) is the only
// input: it exists only when every publication of the release succeeded, and
// it records the exact npm, Maven Central and Swift Package Manager
// coordinates and the OTA manifest the SDK pins.
//
// Commands:
//   resolve    find the newest completed release of a channel (or check a given
//              identity), download and validate its record
//   status     decide whether a Starter Kit branch still needs the release
//   wait       poll until the registries serve every pinned package
//   transform  copy examples/bluetooth and pin it to the release
//   lockfiles  write each React Native example's own bun.lock
//   guard      fail if anything still points at the MentraOS tree
import {spawnSync} from "node:child_process"
import {createHash} from "node:crypto"
import {appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {fileURLToPath} from "node:url"

export const STARTER_KIT_REPOSITORY = "Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit"
export const RELEASE_RECORD_NAME = "starter-kit-release.json"
const ARTIFACT_BASE_URL = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases"
const NPM_REGISTRY = "https://registry.npmjs.org"
const MAVEN_CENTRAL = "https://repo1.maven.org/maven2"
const SDK_PACKAGE = "@mentra/bluetooth-sdk"
const SWIFT_PACKAGE_REPOSITORY = "Mentra-Community/mentra-bluetooth-sdk-ios"
const ENGINE_PACKAGE = "@mentra/engine"
const IDENTITY_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(dev|beta)\.([1-9]\d*))?$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

// The kit branch each channel exports to, and the npm dist-tag that names the
// channel's current release family.
export const CHANNELS = Object.freeze({
  dev: {branch: "dev", distTag: "dev", prerelease: "dev"},
  beta: {branch: "staging", distTag: "beta", prerelease: "beta"},
  production: {branch: "main", distTag: "latest", prerelease: null},
})

function channelOf(channel) {
  const config = CHANNELS[channel]
  if (!config) throw new Error(`Unsupported Starter Kit channel ${JSON.stringify(channel)}`)
  return config
}

export function parseIdentity(identity) {
  const match = IDENTITY_PATTERN.exec(identity || "")
  if (!match) throw new Error(`Invalid release identity ${JSON.stringify(identity)}`)
  return {
    base: `${match[1]}.${match[2]}.${match[3]}`,
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || null,
    sequence: match[5] ? Number(match[5]) : null,
  }
}

export function identityChannel(identity) {
  const {prerelease} = parseIdentity(identity)
  return prerelease === "dev" ? "dev" : prerelease === "beta" ? "beta" : "production"
}

// Orders identities of one channel: by base version, then by sequence. A plain
// X.Y.Z sorts after its own prereleases, as in semver.
export function compareIdentities(left, right) {
  const a = parseIdentity(left)
  const b = parseIdentity(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.sequence === null || b.sequence === null) {
    return (a.sequence === null ? 1 : 0) - (b.sequence === null ? 1 : 0)
  }
  return a.sequence - b.sequence
}

export function releaseContainer(identity) {
  const {base, prerelease} = parseIdentity(identity)
  return prerelease ? `mentra-builds-v${base}` : `mentra-v${identity}`
}

export function releaseRecordUrl(identity) {
  return `${ARTIFACT_BASE_URL}/${releaseContainer(identity)}/mentra-release-${identity}.json`
}

// The newest completed record of a channel in one release container's index.
export function newestRecordedIdentity(index, channel) {
  const prerelease = channelOf(channel).prerelease
  const identities = (index?.assets || [])
    .filter((asset) => asset?.state === "uploaded")
    .map((asset) => /^mentra-release-(.+)\.json$/.exec(asset.name || "")?.[1])
    .filter((identity) => identity && IDENTITY_PATTERN.test(identity))
    .filter((identity) => parseIdentity(identity).prerelease === prerelease)
  return identities.sort(compareIdentities).at(-1) || null
}

function versionOf(coordinate, prefix, label) {
  if (typeof coordinate !== "string" || !coordinate.startsWith(prefix)) {
    throw new Error(`${label} coordinate ${JSON.stringify(coordinate)} must start with ${prefix}`)
  }
  return coordinate.slice(prefix.length)
}

function promotedPublications(record) {
  const coordinates = {
    "npm": (name, version) => `${name}@${version}`,
    "maven-central": (_name, version) => `com.mentraglass:bluetooth-sdk:${version}`,
    "swift-package-manager": (_name, version) => `${SWIFT_PACKAGE_REPOSITORY}@${version}`,
  }
  return Object.fromEntries(
    [SDK_PACKAGE, ENGINE_PACKAGE].map((name) => {
      const member = record.releaseFamily?.members?.[name]
      const targets = name === SDK_PACKAGE ? ["npm", "maven-central", "swift-package-manager"] : ["npm"]
      return [
        name,
        Object.fromEntries(
          targets
            .filter((target) => member?.publishTargets?.includes(target))
            .map((target) => [target, {coordinate: coordinates[target](name, member.version)}]),
        ),
      ]
    }),
  )
}

// Validates a completed release record and extracts what the export pins.
export function exportCoordinates(record, {channel, identity} = {}) {
  if (record?.schemaVersion !== 1 || !IDENTITY_PATTERN.test(record.releaseIdentity || "")) {
    throw new Error("The release record is not a completed coordinated release")
  }
  const releaseIdentity = record.releaseIdentity
  if (identity && releaseIdentity !== identity) {
    throw new Error(`The release record describes ${releaseIdentity}, not ${identity}`)
  }
  const recordChannel = identityChannel(releaseIdentity)
  if (record.channel !== recordChannel || (channel && channel !== recordChannel)) {
    throw new Error(`The release record channel ${record.channel} does not match ${channel || recordChannel}`)
  }
  if (!COMMIT_PATTERN.test(record.sourceCommit || "")) throw new Error("The release record has no source commit")
  if (!/^https:\/\//.test(record.otaManifest?.url || "") || !SHA256_PATTERN.test(record.otaManifest?.sha256 || "")) {
    throw new Error("The release record has no OTA manifest")
  }
  // A dev or beta record lists each publication; the production record
  // (mentra-production-release) lists the family members it promoted.
  const publications = record.kind === "mentra-production-release" ? promotedPublications(record) : record.publications
  const sdk = publications?.[SDK_PACKAGE] || {}
  const engine = publications?.[ENGINE_PACKAGE] || {}
  const npmSdk = versionOf(sdk.npm?.coordinate, `${SDK_PACKAGE}@`, "npm Bluetooth SDK")
  const npmEngine = versionOf(engine.npm?.coordinate, `${ENGINE_PACKAGE}@`, "npm Engine")
  const maven = versionOf(sdk["maven-central"]?.coordinate, "com.mentraglass:bluetooth-sdk:", "Maven Bluetooth SDK")
  const swiftCoordinate = sdk["swift-package-manager"]?.coordinate || ""
  const swift = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(.+)$/.exec(swiftCoordinate)
  if (!swift) throw new Error(`Swift package coordinate ${JSON.stringify(swiftCoordinate)} is invalid`)
  for (const [label, version] of [
    ["npm Bluetooth SDK", npmSdk],
    ["npm Engine", npmEngine],
    ["Maven Bluetooth SDK", maven],
    ["Swift package", swift[2]],
  ]) {
    if (version !== releaseIdentity) throw new Error(`${label} ${version} is not the release ${releaseIdentity}`)
  }
  // The SDK AAR depends on lc3Lib at the same version. Older records list it
  // as a release artifact; it is published together with the SDK either way.
  return {
    releaseIdentity,
    channel: recordChannel,
    branch: CHANNELS[recordChannel].branch,
    sourceCommit: record.sourceCommit,
    otaManifest: {url: record.otaManifest.url, sha256: record.otaManifest.sha256},
    npm: {[SDK_PACKAGE]: npmSdk, [ENGINE_PACKAGE]: npmEngine},
    maven: [`com.mentraglass:bluetooth-sdk:${maven}`, `com.mentraglass:lc3Lib:${maven}`],
    swiftPackage: {
      repository: swift[1],
      url: `https://github.com/${swift[1]}.git`,
      version: swift[2],
    },
  }
}

// --- status -----------------------------------------------------------------

// A branch needs the release unless it already carries it or a newer release
// of the same channel, or the release tag exists. This keeps nightly reruns
// no-ops and stops a late older run from replacing a newer export.
export function exportStatus({kitRecord, identity, tagExists}) {
  if (tagExists) return {needed: false, reason: `sdk-${identity} already exists`}
  const current = kitRecord?.releaseIdentity
  if (current && IDENTITY_PATTERN.test(current) && identityChannel(current) === identityChannel(identity)) {
    if (compareIdentities(current, identity) >= 0) {
      return {needed: false, reason: `the branch already carries ${current}`}
    }
  }
  return {needed: true, reason: current ? `the branch carries ${current}` : "the branch has no exported release"}
}

// --- availability -------------------------------------------------------------

export function mavenPomUrl(coordinate) {
  const [group, artifact, version] = coordinate.split(":")
  return `${MAVEN_CENTRAL}/${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`
}

export async function missingPublications(coordinates, {fetchImpl = fetch, lsRemote = gitTagExists} = {}) {
  const missing = []
  const ok = async (url) => {
    try {
      const response = await fetchImpl(url, {method: "GET", redirect: "follow"})
      return response.ok
    } catch {
      return false
    }
  }
  for (const [name, version] of Object.entries(coordinates.npm)) {
    if (!(await ok(`${NPM_REGISTRY}/${name.replace("/", "%2f")}/${version}`))) missing.push(`npm ${name}@${version}`)
  }
  for (const coordinate of coordinates.maven) {
    if (!(await ok(mavenPomUrl(coordinate)))) missing.push(`Maven Central ${coordinate}`)
  }
  const swift = coordinates.swiftPackage
  if (!(await lsRemote(swift.url, swift.version))) missing.push(`Swift package ${swift.repository}@${swift.version}`)
  try {
    const response = await fetchImpl(coordinates.otaManifest.url, {redirect: "follow"})
    const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : null
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== coordinates.otaManifest.sha256) {
      missing.push(`OTA manifest ${coordinates.otaManifest.url}`)
    }
  } catch {
    missing.push(`OTA manifest ${coordinates.otaManifest.url}`)
  }
  return missing
}

function gitTagExists(url, tag) {
  const result = spawnSync("git", ["ls-remote", "--exit-code", "--tags", url, `refs/tags/${tag}`], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  return result.status === 0
}

// --- transform ----------------------------------------------------------------

function replaceExactlyOnce(contents, pattern, replacement, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  const matches = contents.match(new RegExp(pattern.source, flags))
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches ? matches.length : 0}`)
  }
  return contents.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement)
}

function rewrite(file, edits) {
  let contents = readFileSync(file, "utf8")
  for (const [pattern, replacement, label] of edits)
    contents = replaceExactlyOnce(contents, pattern, replacement, label)
  writeFileSync(file, contents)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

// The React Native examples are the members of the examples/ workspace that
// live in the kit.
export function reactNativeExamples(workspaceManifest, kitRelativePath = "bluetooth") {
  const prefix = `${kitRelativePath}/`
  return (workspaceManifest.workspaces || [])
    .filter((member) => member.startsWith(prefix))
    .map((member) => member.slice(prefix.length))
}

function pinPackageJson(file, coordinates, patches) {
  const manifest = readJson(file)
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(manifest[field] || {})) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) continue
      const version = coordinates.npm[name]
      if (!version) throw new Error(`${file} links ${name} from the workspace, but the release publishes no ${name}`)
      manifest[field][name] = version
    }
  }
  if (Object.keys(patches).length > 0) {
    manifest.patchedDependencies = {...(manifest.patchedDependencies || {}), ...patches}
  }
  writeJson(file, manifest)
}

function transformAndroid(root, coordinates) {
  const android = path.join(root, "android")
  rewrite(path.join(android, "settings.gradle.kts"), [
    [
      /\n(?:\/\/[^\n]*\n)*includeBuild\("[^"]*bluetooth-sdk\/android"\) \{\n[\s\S]*?\n\}\n/,
      "\n",
      "Bluetooth SDK composite build",
    ],
  ])
  writeFileSync(
    path.join(android, "settings.gradle.kts"),
    `${readFileSync(path.join(android, "settings.gradle.kts"), "utf8").trimEnd()}\n`,
  )
  rewrite(path.join(android, "app", "build.gradle.kts"), [
    [
      /implementation\("com\.mentraglass:bluetooth-sdk"\)/,
      'implementation("com.mentraglass:bluetooth-sdk:${property("mentraSdkVersion")}")',
      "unversioned Bluetooth SDK dependency",
    ],
  ])
  const propertiesFile = path.join(android, "gradle.properties")
  const properties = readFileSync(propertiesFile, "utf8")
  if (/^mentraSdkVersion=/m.test(properties)) {
    rewrite(propertiesFile, [
      [/^mentraSdkVersion=.*$/m, `mentraSdkVersion=${coordinates.releaseIdentity}`, "mentraSdkVersion"],
    ])
  } else {
    writeFileSync(propertiesFile, `${properties.trimEnd()}\nmentraSdkVersion=${coordinates.releaseIdentity}\n`)
  }
}

function transformIos(root, coordinates) {
  const ios = path.join(root, "ios")
  const swift = coordinates.swiftPackage
  const packageName = swift.repository.split("/")[1]
  rewrite(path.join(ios, "project.yml"), [
    [
      /^    path: [^\n]*mobile\/modules\/bluetooth-sdk$/m,
      `    url: ${swift.url}\n    exactVersion: ${swift.version}`,
      "local MentraBluetoothSDK package in project.yml",
    ],
  ])
  const projectFile = path.join(ios, "MentraExample.xcodeproj", "project.pbxproj")
  let project = readFileSync(projectFile, "utf8")
  const local = /XCLocalSwiftPackageReference "([^"]*mobile\/modules\/bluetooth-sdk)"/g
  const references = [...project.matchAll(local)]
  if (references.length === 0) throw new Error("Expected the local MentraBluetoothSDK package in project.pbxproj")
  project = project.replace(local, `XCRemoteSwiftPackageReference "${packageName}"`)
  project = replaceExactlyOnce(
    project,
    /\/\* Begin XCLocalSwiftPackageReference section \*\/\n(\t+)([0-9A-F]{24}) \/\* (XCRemoteSwiftPackageReference "[^"]+") \*\/ = \{\n\t+isa = XCLocalSwiftPackageReference;\n\t+relativePath = [^;\n]+;\n\t+\};\n\/\* End XCLocalSwiftPackageReference section \*\//,
    [
      "/* Begin XCRemoteSwiftPackageReference section */",
      "$1$2 /* $3 */ = {",
      "$1\tisa = XCRemoteSwiftPackageReference;",
      `$1\trepositoryURL = "${swift.url}";`,
      "$1\trequirement = {",
      "$1\t\tkind = exactVersion;",
      `$1\t\tversion = ${swift.version};`,
      "$1\t};",
      "$1};",
      "/* End XCRemoteSwiftPackageReference section */",
    ].join("\n"),
    "local Swift package reference section",
  )
  writeFileSync(projectFile, project)
}

function transformMacos(root, coordinates) {
  const swift = coordinates.swiftPackage
  const packageName = swift.repository.split("/")[1]
  rewrite(path.join(root, "macos", "Package.swift"), [
    [
      /^(?:\/\/[^\n]*\n)+(?=let package = Package\()/m,
      `// Uses the published Mentra Bluetooth SDK Swift package.\nlet sdkVersion = "${swift.version}"\n\n`,
      "Package.swift source comment",
    ],
    [
      /\.package\(name: "MentraBluetoothSDK", path: "[^"]*mobile\/modules\/bluetooth-sdk"\)/,
      `.package(url: "${swift.url}", exact: Version(sdkVersion)!)`,
      "local MentraBluetoothSDK package in Package.swift",
    ],
    [/package: "MentraBluetoothSDK"\)/, `package: "${packageName}")`, "MentraBluetoothSDK product package"],
  ])
}

export function starterKitReleaseRecord({record, recordSha256, coordinates}) {
  return {
    schemaVersion: 1,
    kind: "mentra-bluetooth-starter-kit",
    releaseIdentity: coordinates.releaseIdentity,
    channel: coordinates.channel,
    sourceRepository: "Mentra-Community/MentraOS",
    sourceCommit: coordinates.sourceCommit,
    sourcePath: "examples/bluetooth",
    releaseRecord: {url: releaseRecordUrl(record.releaseIdentity), sha256: recordSha256},
    otaManifest: coordinates.otaManifest,
    packages: {
      npm: coordinates.npm,
      maven: coordinates.maven,
      swiftPackage: {url: coordinates.swiftPackage.url, exactVersion: coordinates.swiftPackage.version},
    },
  }
}

// Copies the kit and pins every SDK reference to the release. Each rewrite
// must match exactly once, so a changed source layout fails the export
// instead of producing a kit that silently still points at MentraOS.
export function transformStarterKit({
  examplesDir,
  workspaceDir = path.dirname(examplesDir),
  outDir,
  record,
  recordSha256,
}) {
  const coordinates = exportCoordinates(record)
  const source = path.resolve(examplesDir)
  const output = path.resolve(outDir)
  if (output === source || output.startsWith(`${source}${path.sep}`)) {
    throw new Error("The export must be written outside the source tree")
  }
  rmSync(output, {recursive: true, force: true})
  cpSync(source, output, {
    recursive: true,
    filter: (file) =>
      !/(^|\/)(node_modules|\.gradle|build|Pods|\.expo|\.build|\.swiftpm)(\/|$)/.test(path.relative(source, file)),
  })

  transformAndroid(output, coordinates)
  transformIos(output, coordinates)
  transformMacos(output, coordinates)

  const workspaceManifest = readJson(path.join(workspaceDir, "package.json"))
  const patches = workspaceManifest.patchedDependencies || {}
  const kitRelativePath = path.relative(path.resolve(workspaceDir), source).split(path.sep).join("/")
  const examples = reactNativeExamples(workspaceManifest, kitRelativePath)
  if (examples.length === 0) throw new Error("No React Native example is a member of the examples workspace")
  for (const example of examples) {
    const directory = path.join(output, example)
    // The workspace applies its Bun patches to every member, so each
    // standalone example carries them.
    for (const patchFile of Object.values(patches)) {
      mkdirSync(path.join(directory, path.dirname(patchFile)), {recursive: true})
      cpSync(path.join(workspaceDir, patchFile), path.join(directory, patchFile))
    }
    pinPackageJson(path.join(directory, "package.json"), coordinates, patches)
  }

  writeJson(path.join(output, RELEASE_RECORD_NAME), starterKitReleaseRecord({record, recordSha256, coordinates}))
  return {coordinates, examples}
}

// Seeds each example's lockfile from the workspace lockfile, so the standalone
// example resolves the same third-party versions the workspace tested, and
// lets Bun prune it to the example and add the published SDK packages.
export function writeLockfiles({outDir, workspaceDir, examples, bun = "bun"}) {
  const seed = path.join(workspaceDir, "bun.lock")
  for (const example of examples) {
    const directory = path.join(outDir, example)
    if (existsSync(seed)) cpSync(seed, path.join(directory, "bun.lock"))
    const result = spawnSync(bun, ["install", "--lockfile-only"], {cwd: directory, stdio: "inherit"})
    if (result.status !== 0) throw new Error(`bun install --lockfile-only failed in ${example}`)
    verifyPatchedLockfile(directory)
  }
}

// A patch keyed on a version the lockfile no longer resolves would be dropped
// silently; fail instead.
export function verifyPatchedLockfile(directory) {
  const manifest = readJson(path.join(directory, "package.json"))
  const lockfile = readFileSync(path.join(directory, "bun.lock"), "utf8")
  for (const key of Object.keys(manifest.patchedDependencies || {})) {
    const at = key.lastIndexOf("@")
    const name = key.slice(0, at)
    if (!lockfile.includes(`"${name}": ["${key}"`)) {
      throw new Error(`${path.basename(directory)} patches ${key}, but its lockfile resolves another version`)
    }
  }
}

// --- guard --------------------------------------------------------------------

const BUILD_FILE =
  /(^|\/)(package\.json|bun\.lock|settings\.gradle(\.kts)?|build\.gradle(\.kts)?|gradle\.properties|Package\.swift|project\.yml|project\.pbxproj|Podfile|[^/]+\.podspec|app\.json|app\.config\.[cm]?js|tsconfig[^/]*\.json|babel\.config\.[cm]?js)$|(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/
const SOURCE_REFERENCES = [
  [/workspace:/, "a workspace: dependency"],
  [/(?:\.\.\/)+(?:mobile|cloud-v2|sdk|examples)\//, "a relative path into the MentraOS tree"],
  [/mobile\/modules\//, "a MentraOS mobile/modules path"],
  [/cloud-v2\/packages\//, "a MentraOS cloud-v2/packages path"],
  [/includeBuild\(/, "a Gradle composite build"],
  [/XCLocalSwiftPackageReference/, "a local Swift package reference"],
  [/\.package\([^)]*\bpath:/, "a local Swift package dependency"],
  [/"file:\.\.\//, "a file: dependency outside the example"],
]

function listFiles(directory, base = directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".git" ? [] : listFiles(file, base)
    return [path.relative(base, file).split(path.sep).join("/")]
  })
}

export function sourceReferences(root) {
  const findings = []
  for (const file of listFiles(root)) {
    if (!BUILD_FILE.test(file)) continue
    const contents = readFileSync(path.join(root, file), "utf8")
    for (const [pattern, label] of SOURCE_REFERENCES) {
      const lines = contents.split("\n")
      lines.forEach((line, index) => {
        if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${label}: ${line.trim().slice(0, 160)}`)
      })
    }
  }
  if (!existsSync(path.join(root, RELEASE_RECORD_NAME))) findings.push(`${RELEASE_RECORD_NAME} is missing`)
  return findings
}

export function guardStarterKit(root) {
  const findings = sourceReferences(root)
  if (findings.length > 0) {
    throw new Error(`The exported Starter Kit still depends on the MentraOS tree:\n${findings.join("\n")}`)
  }
}

// --- CLI ----------------------------------------------------------------------

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

function output(values, githubOutput) {
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(String(value))) throw new Error(`Output ${key} must be a single line`)
    console.log(`${key}=${value}`)
    if (githubOutput) appendFileSync(githubOutput, `${key}=${value}\n`)
  }
}

async function fetchBytes(url) {
  const response = await fetch(url, {redirect: "follow"})
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function resolve(args) {
  const channel = args.channel
  const config = channelOf(channel)
  let identity = args.identity || ""
  if (!identity) {
    const tags = JSON.parse(
      (await fetchBytes(`${NPM_REGISTRY}/-/package/${SDK_PACKAGE.replace("/", "%2f")}/dist-tags`)).toString(),
    )
    const current = tags[config.distTag]
    if (!current) throw new Error(`${SDK_PACKAGE} has no ${config.distTag} dist-tag`)
    if (channel === "production") {
      identity = current
    } else {
      // The dist-tag moves when npm publishes, before the release finishes;
      // the container index lists only the records of completed releases.
      const indexBytes = await fetchBytes(`${ARTIFACT_BASE_URL}/${releaseContainer(current)}/_assets.json`)
      identity = indexBytes ? newestRecordedIdentity(JSON.parse(indexBytes.toString()), channel) || "" : ""
    }
  }
  if (identity && identityChannel(identity) !== channel) {
    throw new Error(`${identity} is not a ${channel} release`)
  }
  const bytes = identity ? await fetchBytes(releaseRecordUrl(identity)) : null
  if (!bytes) {
    output({found: "false", identity, branch: config.branch}, args["github-output"])
    return
  }
  const record = JSON.parse(bytes.toString())
  const coordinates = exportCoordinates(record, {channel, identity})
  mkdirSync(path.dirname(path.resolve(args.output)), {recursive: true})
  writeFileSync(path.resolve(args.output), bytes)
  output(
    {
      found: "true",
      identity: coordinates.releaseIdentity,
      branch: coordinates.branch,
      source_commit: coordinates.sourceCommit,
      record_url: releaseRecordUrl(coordinates.releaseIdentity),
      record_sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    args["github-output"],
  )
}

async function wait(args) {
  const record = readJson(path.resolve(args.record))
  const coordinates = exportCoordinates(record)
  const deadline = Date.now() + Number(args["timeout-minutes"] || 45) * 60_000
  const interval = Number(args["interval-seconds"] || 60) * 1000
  let missing
  for (;;) {
    missing = await missingPublications(coordinates)
    if (missing.length === 0 || Date.now() + interval > deadline) break
    console.log(`Waiting for: ${missing.join("; ")}`)
    await sleep(interval)
  }
  output({ready: String(missing.length === 0), missing: missing.join("; ")}, args["github-output"])
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === "resolve") return resolve(args)
  if (command === "wait") return wait(args)
  if (command === "status") {
    const file = path.join(path.resolve(args["kit-dir"]), RELEASE_RECORD_NAME)
    const kitRecord = existsSync(file) ? readJson(file) : null
    const status = exportStatus({kitRecord, identity: args.identity, tagExists: args["tag-exists"] === "true"})
    output({needed: String(status.needed), reason: status.reason}, args["github-output"])
    return
  }
  if (command === "transform") {
    const recordBytes = readFileSync(path.resolve(args.record))
    const {examples} = transformStarterKit({
      examplesDir: args["examples-dir"],
      workspaceDir: args["workspace-dir"] || path.dirname(path.resolve(args["examples-dir"])),
      outDir: args.out,
      record: JSON.parse(recordBytes.toString()),
      recordSha256: createHash("sha256").update(recordBytes).digest("hex"),
    })
    if (args.lockfiles !== "false") {
      writeLockfiles({
        outDir: path.resolve(args.out),
        workspaceDir: args["workspace-dir"] || path.dirname(path.resolve(args["examples-dir"])),
        examples,
      })
    }
    guardStarterKit(path.resolve(args.out))
    console.log(`Exported the Starter Kit to ${args.out}`)
    return
  }
  if (command === "guard") {
    guardStarterKit(path.resolve(args.dir))
    console.log(`${args.dir} has no MentraOS source references`)
    return
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
