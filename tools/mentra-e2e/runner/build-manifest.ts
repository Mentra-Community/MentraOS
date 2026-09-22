import type {Doctor} from "./driver"

type RunningBuild = Pick<Doctor, "bundleId" | "version" | "build"> & {
  executableSha256: unknown
  javascriptSha256: unknown
}

const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const CI_FIELDS = [
  "pr",
  "headSha",
  "buildSha",
  "runId",
  "runAttempt",
  "bundleId",
  "app",
  "backend",
  "otaManifestUrl",
  "macPackageVersion",
  "macInstaller",
  "mobileFingerprint",
  "mobileSourceCommit",
  "reusedCompilation",
  "version",
  "build",
  "executableSha256",
  "javascriptSha256",
  "profileUUID",
  "profileExpires",
  "teamId",
]
const textMatches = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value)
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0

/** Match a supplied manifest to observed app bytes; CI authenticity is checked by the artifact importer. */
export function verifyBuildManifest(input: unknown, running: RunningBuild): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid build manifest")
  const manifest = input as Record<string, unknown>
  const isCi = ["pr", "headSha", "buildSha", "runId", "runAttempt", "mobileSourceCommit", "reusedCompilation"].some(
    (key) => Object.hasOwn(manifest, key),
  )
  const matchingBytes =
    manifest.bundleId === running.bundleId &&
    manifest.executableSha256 === running.executableSha256 &&
    Boolean(manifest.javascriptSha256) &&
    manifest.javascriptSha256 === running.javascriptSha256

  if (!isCi) {
    if (manifest.configuration !== "Release" || !matchingBytes)
      throw new Error("Build manifest does not match the running Release app's identity and binary/JavaScript hashes")
    return {
      verifiedLocalBuild: manifest,
      installedAppCommit: manifest.sourceStatus === "" ? manifest.sourceCommit : null,
    }
  }

  if (
    Object.keys(manifest).some((key) => !CI_FIELDS.includes(key)) ||
    !positiveInteger(manifest.pr) ||
    !positiveInteger(manifest.runId) ||
    !positiveInteger(manifest.runAttempt) ||
    !textMatches(manifest.headSha, SHA) ||
    !textMatches(manifest.buildSha, SHA) ||
    !textMatches(manifest.mobileSourceCommit, SHA) ||
    !textMatches(manifest.mobileFingerprint, HASH) ||
    typeof manifest.reusedCompilation !== "boolean" ||
    (!manifest.reusedCompilation && manifest.mobileSourceCommit !== manifest.buildSha) ||
    manifest.bundleId !== "com.mentra.mentra" ||
    manifest.teamId !== "T5XXXL6N36" ||
    manifest.app !== "Mentra.app" ||
    manifest.backend !== "dev" ||
    manifest.macPackageVersion !== 2 ||
    manifest.macInstaller !== "Install Mentra.app" ||
    !textMatches(manifest.version, /^\d+\.\d+\.\d+$/) ||
    !textMatches(manifest.build, /^[1-9]\d*$/) ||
    !textMatches(manifest.executableSha256, HASH) ||
    !textMatches(manifest.javascriptSha256, HASH) ||
    !textMatches(manifest.profileUUID, /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/) ||
    typeof manifest.profileExpires !== "string" ||
    !Number.isFinite(Date.parse(manifest.profileExpires)) ||
    manifest.otaManifestUrl !==
      `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-${manifest.pr}-${manifest.headSha}.json`
  )
    throw new Error("Invalid CI Mac build manifest or PR OTA pin")
  if (!matchingBytes || manifest.version !== running.version || manifest.build !== running.build)
    throw new Error(
      "CI build manifest does not match the running app's bundle, version, build and binary/JavaScript hashes",
    )

  return {
    verifiedCiBuild: manifest,
    // A repackaged PR can retain an earlier compilation. Neither PR headSha nor
    // buildSha establishes the revision from which its executable was compiled.
    installedAppCommit: manifest.mobileSourceCommit,
  }
}
