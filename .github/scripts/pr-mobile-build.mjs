import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {downloadAsset, mergeAssets, readArtifactIndex} from "./release-artifact-storage.mjs"

// Include shared Metro sources and native inputs, not just mobile/. Firmware
// selection and per-run packaging metadata do not change the compiled app.
export const MOBILE_INPUT_PATHS = [
  "mobile",
  "cloud-v2",
  "android_core",
  "package.json",
  "bun.lock",
  ".github/workflows/mentra-app-android-build.yml",
  ".github/workflows/mentra-app-ios-build.yml",
  ".github/actions/inject-signing",
  ".github/scripts/pr-mobile-build.mjs",
  ".github/scripts/prepare-pr-mobile.mjs",
  ".github/scripts/pr_mobile_config.py",
  ".github/scripts/repackage-pr-apk.py",
]
export const MOBILE_PR_PATHS = [
  "mobile/**",
  "cloud-v2/**",
  "android_core/**",
  "asg_client/**",
  "package.json",
  "bun.lock",
  ".github/workflows/mentra-app-android-build.yml",
  ".github/workflows/mentra-asg-client-build.yml",
  ".github/actions/inject-signing/**",
  ".github/scripts/pr-mobile-build*",
  ".github/scripts/ensure-android-ndk*",
  ".github/scripts/pr_mobile_config.py",
  ".github/scripts/prepare-pr-mobile.mjs",
  ".github/scripts/repackage-pr-apk*",
  ".github/scripts/test_repackage_pr_apk.py",
  ".github/scripts/notify-pr-builds*",
  ".github/workflows/mentra-app-ios-build.yml",
  ".github/workflows/reusable-pr-build-notification.yml",
  ".github/scripts/pr-ios-artifacts*",
  ".github/scripts/pr-android-artifacts*",
  ".github/scripts/select-pr-asg.mjs",
  ".github/scripts/compute-asg-build-identity.mjs",
  ".github/scripts/allocate-asg-version.mjs",
  ".github/scripts/build-bluetooth-sdk-ota-manifest.mjs",
]

const packagingKeys = new Set(["EXPO_PUBLIC_ASG_OTA_VERSION_URL"])

/** A staging-targeted PR app uses staging services; every other PR keeps dev.
 * The backend is compiled in and fingerprinted, so reuse never crosses backends. */
export const prBackend = (baseRef) => (baseRef === "staging" ? "staging" : "dev")
const hash = (value) => createHash("sha256").update(value).digest("hex")
const transientNetworkCodes = new Set(["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EAI_AGAIN"])

function transientCacheFailure(error) {
  if (transientNetworkCodes.has(error?.code)) return error.code
  const status = error?.$metadata?.httpStatusCode
  if ([429, 500, 502, 503, 504].includes(status)) return `HTTP ${status}`
  return null
}

export function fingerprintMobile({tree, env, tools}) {
  const embeddedEnv = Object.fromEntries(
    Object.entries(env)
      .filter(
        ([key]) =>
          !packagingKeys.has(key) &&
          (key.startsWith("EXPO_PUBLIC_") ||
            ["MENTRAOS_BUILD_NAME", "MENTRAOS_NATIVE_MARKETING_VERSION", "NODE_ENV"].includes(key)),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  return hash(JSON.stringify({schemaVersion: 1, tree, embeddedEnv, tools}))
}

export function candidateAssets(assets, fingerprint, platform = "android") {
  const name =
    platform === "ios" ? /^mentra-ios-iphone-pr-\d+-[a-f0-9]{40}-\d+-\d+\.ipa$/ : /^mobile-pr-\d+-[a-f0-9]{7}\.apk$/
  return assets
    .filter(
      (asset) => name.test(asset.name) && new RegExp(`^mobile-v1:${fingerprint}:[a-f0-9]{64}$`).test(asset.label ?? ""),
    )
    .sort(
      (a, b) =>
        Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0) ||
        Number(b.id) - Number(a.id),
    )
}

export async function selectMobile({
  github,
  context,
  core,
  platform = "android",
  env = process.env,
  exec = execFileSync,
  download = downloadAsset,
  readIndex = readArtifactIndex,
}) {
  const fingerprint = env.MENTRA_PR_MOBILE_FINGERPRINT
  const candidate = platform === "ios" ? "pr-mobile-candidate.ipa" : "pr-mobile-candidate.apk"
  const repo = context.repo
  const {data: release} = await github.rest.repos.getReleaseByTag({...repo, tag: "pr-builds"})
  const legacy = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: release.id,
    per_page: 100,
  })
  const repository = `${repo.owner}/${repo.repo}`
  let indexed = []
  try {
    indexed = (await readIndex(repository, "pr-builds")).assets
  } catch (error) {
    const transient = transientCacheFailure(error)
    if (!transient) throw error
    // Reuse is optional. Do not hide credential/configuration/integrity errors,
    // and leave publication's required upload and verification unchanged.
    core.warning(`Reuse index temporarily unavailable (${transient}); checking GitHub candidates or building the app.`)
  }
  const assets = mergeAssets(legacy, indexed)
  for (const asset of candidateAssets(assets, fingerprint, platform)) {
    try {
      if (String(asset.id).startsWith("r2:")) {
        await download(repository, asset, candidate)
      } else {
        const response = await github.rest.repos.getReleaseAsset({
          ...repo,
          asset_id: asset.id,
          headers: {accept: "application/octet-stream"},
        })
        const bytes = Buffer.from(response.data)
        if (hash(bytes) !== asset.label.split(":")[2]) throw new Error("APK checksum mismatch")
        writeFileSync(candidate, bytes)
      }
      if (hash(readFileSync(candidate)) !== asset.label.split(":")[2]) throw new Error("Candidate checksum mismatch")
      // Both platforms verify embedded provenance and the current signing identity.
      exec(
        "python3",
        [
          platform === "ios" ? "mobile/ci/pr-ios/repackage.py" : ".github/scripts/repackage-pr-apk.py",
          "verify-base",
          candidate,
          fingerprint,
        ],
        {stdio: "inherit", env},
      )
      core.setOutput("reused", "true")
      core.info(`Reusing signed ${platform} app ${asset.name}`)
      return
    } catch (error) {
      core.warning(`Cannot reuse ${asset.name}: ${error.message}`)
    }
  }
  core.setOutput("reused", "false")
  core.info("No valid matching signed app remains; building the app.")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.loadEnvFile("mobile/.env")
  const platform = process.argv[2] || "android"
  if (!["android", "ios"].includes(platform)) throw new Error("Expected android or ios")
  const tree = execFileSync("git", ["ls-tree", "-r", "HEAD", "--", ...MOBILE_INPUT_PATHS], {encoding: "utf8"})
  const fingerprint = fingerprintMobile({
    tree,
    env: process.env,
    tools: {
      target: platform,
      node: process.versions.node,
      bun: execFileSync("bun", ["--version"], {encoding: "utf8"}).trim(),
      ...(platform === "ios"
        ? {
            xcode: execFileSync("xcodebuild", ["-version"], {encoding: "utf8"}).trim(),
            sdk: execFileSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-build-version"], {encoding: "utf8"}).trim(),
          }
        : {
            java: execFileSync("java", ["--version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim(),
            androidBuildTools: "36.0.0",
            abi: "arm64-v8a",
          }),
      platform: process.platform,
      arch: process.arch,
    },
  })
  appendFileSync(process.env.GITHUB_ENV, `MENTRA_PR_MOBILE_FINGERPRINT=${fingerprint}\n`)
  console.log(`Mobile build fingerprint: ${fingerprint}`)
}
