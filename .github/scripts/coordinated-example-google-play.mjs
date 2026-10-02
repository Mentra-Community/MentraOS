#!/usr/bin/env node
import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, readFileSync, writeFileSync} from "node:fs"
import {pathToFileURL} from "node:url"
import {resolveAndroidVersionCode} from "./resolve-android-version-code.mjs"

export const EXAMPLE_PACKAGE_ID = "com.mentra.bluetoothsdkexample"
const installUrl = `https://play.google.com/apps/testing/${EXAMPLE_PACKAGE_ID}`
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

export function requireExampleBuildNumber(plan, buildNumber) {
  if (!Number.isSafeInteger(buildNumber) || buildNumber < plan.native.buildNumber || buildNumber > 2100000000)
    throw new Error("Example Android version code must be at least the family number and within Play's limit")
  return buildNumber
}

// Separate package, separate reservations, shared cross-family release container.
// The job's app-wide concurrency lock covers lookup, reservation and publication.
export function allocateExampleBuildNumber(plan, track, codes, used, assets) {
  const owner = createHash("sha256").update(plan.releaseSetId).digest("hex")
  const reservations = assets.flatMap(({name}) => {
    const match = /^mentra-example-android-code-(\d+)-([a-f0-9]{64})\.json$/.exec(name)
    return match ? [{code: Number(match[1]), owner: match[2]}] : []
  })
  const result = resolveAndroidVersionCode({
    planBuildNumber: plan.native.buildNumber,
    track,
    trackCodes: [...codes, ...used],
    usedCodes: used,
    reservations,
    owner,
  })
  requireExampleBuildNumber(plan, result.versionCode)
  return {
    ...result,
    markerName: `mentra-example-android-code-${result.versionCode}-${owner}.json`,
    releaseSetId: plan.releaseSetId,
    packageId: EXAMPLE_PACKAGE_ID,
    planBuildNumber: plan.native.buildNumber,
    track,
  }
}

export function verifyExampleAabIdentity(
  plan,
  aab,
  bundletool,
  run = execFileSync,
  buildNumber = plan.native.buildNumber,
) {
  const expected = {
    "package": EXAMPLE_PACKAGE_ID,
    "android:versionCode": String(requireExampleBuildNumber(plan, buildNumber)),
    "android:versionName": plan.native.marketingVersion,
  }
  for (const [attribute, value] of Object.entries(expected)) {
    const actual = run(
      "java",
      ["-jar", bundletool, "dump", "manifest", `--bundle=${aab}`, "--module=base", `--xpath=/manifest/@${attribute}`],
      {encoding: "utf8"},
    ).trim()
    if (actual !== value)
      throw new Error(`AAB ${attribute} ${JSON.stringify(actual)} does not match ${JSON.stringify(value)}`)
  }
}

export function examplePlayAudience(channel) {
  return channel === "beta" ? "external" : "internal"
}

export function examplePlayCoordinates(plan, starterKit, track) {
  // The production example has its own closed track, created in Play Console
  // under exactly this name, so it never competes with the dev and beta
  // examples for the internal and open-testing tracks (a track serves one
  // release at a time). It is never promoted to a Play production release.
  const expectedTrack = {
    dev: "internal",
    beta: "beta",
    production: "Mentra Bluetooth Example Production Candidates",
  }[plan.channel]
  if (!expectedTrack || track !== expectedTrack) throw new Error("Example Google Play track does not match the channel")
  if (
    starterKit.releaseSetId !== plan.releaseSetId ||
    starterKit.releaseIdentity !== plan.releaseIdentity ||
    starterKit.channel !== plan.channel ||
    starterKit.mentraos?.sourceCommit !== plan.sourceCommit ||
    !/^[0-9a-f]{40}$/.test(starterKit.starterKit?.baseCommit || "") ||
    !/^[0-9a-f]{40}$/.test(starterKit.starterKit?.releaseCommit || "") ||
    ["@mentra/bluetooth-sdk", "@mentra/engine"].some((name) => starterKit.packages?.[name] !== plan.releaseIdentity)
  )
    throw new Error("Example Google Play source does not match the validated Starter Kit release")
  if (
    !Number.isSafeInteger(plan.native?.buildNumber) ||
    plan.native.buildNumber < 1 ||
    plan.native.buildNumber > 2100000000
  ) {
    throw new Error("Example Google Play requires a valid coordinated Android version code")
  }
  const aabName = `mentra-example-react-native-${plan.releaseIdentity}.aab`
  return {
    release_identity: plan.releaseIdentity,
    starter_release_commit: starterKit.starterKit.releaseCommit,
    build_number: plan.native.buildNumber,
    container_tag: plan.artifactContainerTag,
    aab_name: aabName,
    aab_url: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/${plan.artifactContainerTag}/${aabName}`,
    result_artifact: `coordinated-example-google-play-${plan.releaseSetId}`,
    install_url: installUrl,
  }
}

export function configureExampleAndroid(plan, config, packageJson, buildNumber = plan.native.buildNumber) {
  if (!["dev", "beta", "production"].includes(plan.channel)) {
    throw new Error("Only coordinated dev, beta, or production examples are supported")
  }
  for (const name of ["@mentra/bluetooth-sdk", "@mentra/engine"]) {
    if (packageJson.dependencies?.[name] !== plan.releaseIdentity)
      throw new Error(`Example ${name} must match the release`)
  }
  return {
    ...config,
    expo: {
      ...config.expo,
      version: plan.native.marketingVersion,
      android: {
        ...config.expo.android,
        package: EXAMPLE_PACKAGE_ID,
        versionCode: requireExampleBuildNumber(plan, buildNumber),
      },
    },
  }
}

export function validateExampleGooglePlay(plan, starterKit, record) {
  const coordinates = examplePlayCoordinates(plan, starterKit, record?.track)
  requireExampleBuildNumber(plan, record?.version?.buildNumber)
  if (
    record?.schemaVersion !== 1 ||
    record.releaseSetId !== plan.releaseSetId ||
    record.releaseIdentity !== plan.releaseIdentity ||
    record.channel !== plan.channel ||
    record.mentraosSourceCommit !== plan.sourceCommit ||
    record.starterKitReleaseCommit !== starterKit.starterKit.releaseCommit ||
    record.packageId !== EXAMPLE_PACKAGE_ID ||
    record.version?.marketingVersion !== plan.native.marketingVersion ||
    !["published", "reused"].includes(record.uploadStatus) ||
    record.distribution?.status !== "submitted" ||
    record.distribution?.audience !== examplePlayAudience(plan.channel) ||
    record.distribution?.installUrl !== installUrl ||
    ![
      coordinates.aab_url,
      coordinates.aab_url
        .replace("https://artifactscdn.mentraglass.com/", "https://github.com/")
        .replace("/releases/", "/releases/download/"),
    ].includes(record.aab?.url) ||
    !/^[0-9a-f]{64}$/.test(record.aab?.sha256 || "") ||
    !Number.isSafeInteger(record.aab?.size) ||
    record.aab.size < 1 ||
    !/^https:\/\/github\.com\/Mentra-Community\/MentraOS\/actions\/runs\/\d+$/.test(record.provenanceUrl || "")
  )
    throw new Error("Example Google Play publication evidence does not match the release")
  return record
}

export function createExampleGooglePlayRecord({
  plan,
  starterKit,
  track,
  codes,
  aab,
  artifactUrl,
  uploadStatus,
  provenanceUrl,
  buildNumber = plan.native.buildNumber,
}) {
  examplePlayCoordinates(plan, starterKit, track)
  requireExampleBuildNumber(plan, buildNumber)
  if (!Array.isArray(codes) || !codes.map(Number).includes(buildNumber)) {
    throw new Error("Google Play did not retain the exact coordinated version code")
  }
  return validateExampleGooglePlay(plan, starterKit, {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    mentraosSourceCommit: plan.sourceCommit,
    starterKitReleaseCommit: starterKit.starterKit.releaseCommit,
    packageId: EXAMPLE_PACKAGE_ID,
    version: {marketingVersion: plan.native.marketingVersion, buildNumber},
    track,
    uploadStatus,
    // Track acceptance is not proof that review or tester availability has completed.
    distribution: {status: "submitted", audience: examplePlayAudience(plan.channel), installUrl},
    aab: {url: artifactUrl, sha256: createHash("sha256").update(aab).digest("hex"), size: aab.length},
    provenanceUrl,
  })
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || args[index + 1] === undefined) throw new Error("Expected --name value pairs")
    options[args[index].slice(2)] = args[index + 1]
  }
  const plan = readJson(options.plan)
  if (command === "allocate") {
    const result = allocateExampleBuildNumber(
      plan,
      options.track,
      readJson(options.codes),
      readJson(options.used),
      readJson(options.assets),
    )
    writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`)
    return
  }
  const buildNumber =
    command === "coordinates"
      ? plan.native.buildNumber
      : requireExampleBuildNumber(plan, Number(options["build-number"]))
  if (command === "verify-aab") {
    verifyExampleAabIdentity(plan, options.aab, options.bundletool, execFileSync, buildNumber)
    return
  }
  if (command === "configure") {
    const result = configureExampleAndroid(plan, readJson(options.app), readJson(options.package), buildNumber)
    writeFileSync(options.app, `${JSON.stringify(result, null, 2)}\n`)
    return
  }
  const starterKit = readJson(options["starter-kit"])
  if (command === "coordinates") {
    const coordinates = examplePlayCoordinates(plan, starterKit, options.track)
    for (const [name, value] of Object.entries(coordinates)) {
      if (/[\r\n]/.test(String(value))) throw new Error("Invalid multiline release coordinate")
      appendFileSync(options.output, `${name}=${value}\n`)
    }
    return
  }
  if (command !== "record") throw new Error(`Unknown command: ${command}`)
  const record = createExampleGooglePlayRecord({
    plan,
    starterKit,
    track: options.track,
    codes: readJson(options.codes),
    aab: readFileSync(options.aab),
    artifactUrl: options["artifact-url"],
    uploadStatus: options["upload-status"],
    provenanceUrl: options["provenance-url"],
    buildNumber,
  })
  writeFileSync(options.output, `${JSON.stringify(record, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
