import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

// Include shared Metro sources and native inputs, not just mobile/. Firmware
// selection and per-run packaging metadata do not change the compiled app.
export const MOBILE_INPUT_PATHS = [
  "mobile",
  "cloud-v2",
  "android_core",
  "package.json",
  "bun.lock",
  ".github/workflows/mentra-app-android-build.yml",
  ".github/actions/inject-signing",
  ".github/scripts/pr-mobile-build.mjs",
  ".github/scripts/repackage-pr-apk.py",
]
const packagingKeys = new Set(["EXPO_PUBLIC_ASG_OTA_VERSION_URL"])
const hash = (value) => createHash("sha256").update(value).digest("hex")

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

export function candidateAssets(assets, fingerprint) {
  return assets
    .filter(
      (asset) =>
        /^mobile-pr-\d+-[a-f0-9]{7}\.apk$/.test(asset.name) &&
        new RegExp(`^mobile-v1:${fingerprint}:[a-f0-9]{64}$`).test(asset.label ?? ""),
    )
    .sort((a, b) => b.id - a.id)
}

export async function selectMobile({github, context, core}) {
  const fingerprint = process.env.MENTRA_PR_APK_FINGERPRINT
  const repo = context.repo
  const {data: release} = await github.rest.repos.getReleaseByTag({...repo, tag: "pr-builds"})
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: release.id,
    per_page: 100,
  })
  for (const asset of candidateAssets(assets, fingerprint)) {
    try {
      const response = await github.rest.repos.getReleaseAsset({
        ...repo,
        asset_id: asset.id,
        headers: {accept: "application/octet-stream"},
      })
      const bytes = Buffer.from(response.data)
      if (hash(bytes) !== asset.label.split(":")[2]) throw new Error("APK checksum mismatch")
      writeFileSync("pr-mobile-candidate.apk", bytes)
      // Also checks the embedded fingerprint and current upload certificate.
      execFileSync(
        "python3",
        [".github/scripts/repackage-pr-apk.py", "verify-base", "pr-mobile-candidate.apk", fingerprint],
        {stdio: "inherit"},
      )
      core.setOutput("reused", "true")
      core.info(`Reusing signed APK ${asset.name}`)
      return
    } catch (error) {
      core.warning(`Cannot reuse ${asset.name}: ${error.message}`)
    }
  }
  core.setOutput("reused", "false")
  core.info("No valid matching signed APK remains; building the app.")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.loadEnvFile("mobile/.env")
  const tree = execFileSync("git", ["ls-tree", "-r", "HEAD", "--", ...MOBILE_INPUT_PATHS], {encoding: "utf8"})
  const fingerprint = fingerprintMobile({
    tree,
    env: process.env,
    tools: {
      node: process.versions.node,
      bun: execFileSync("bun", ["--version"], {encoding: "utf8"}).trim(),
      java: execFileSync("java", ["--version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim(),
      platform: process.platform,
      arch: process.arch,
      androidBuildTools: "36.0.0",
      abi: "arm64-v8a",
    },
  })
  appendFileSync(process.env.GITHUB_ENV, `MENTRA_PR_APK_FINGERPRINT=${fingerprint}\n`)
  console.log(`Mobile build fingerprint: ${fingerprint}`)
}
