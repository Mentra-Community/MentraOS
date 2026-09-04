#!/usr/bin/env zx
import {config} from "dotenv"
import {execFileSync} from "child_process"
import {writeFile, readFile, chmod} from "fs/promises"
import {homedir} from "os"
import {join} from "path"
import {generateBundledMiniapps} from "./generate-bundled-miniapps.mjs"
import {syncAutolinkingCache} from "./clear-autolinking-cache.mjs"

/**
 * When the Mapbox Downloads:Read secret token (sk.…) is present in the
 * environment — i.e. the build is running under `doppler run` (the opt-in easy
 * path) — mirror it into ~/.netrc so iOS SPM can authenticate to api.mapbox.com
 * and fetch the Nav SDK. Android's Gradle reads the same token straight from the
 * environment (System.getenv), so it needs no file.
 *
 * No-op when the token is absent or still the .env dummy, so a developer using
 * the manual fallback (their own ~/.gradle/gradle.properties + ~/.netrc) is left
 * untouched.
 */
async function syncMapboxNetrc() {
  const token = process.env.MAPBOX_DOWNLOADS_TOKEN
  if (!token || !token.startsWith("sk.")) return // absent or dummy -> manual fallback

  const netrcPath = join(homedir(), ".netrc")
  let existing = ""
  try {
    existing = await readFile(netrcPath, "utf8")
  } catch {
    /* no ~/.netrc yet — we'll create it */
  }

  // Drop any prior api.mapbox.com machine block (3 lines) so we don't stack
  // stale credentials on repeated runs, then append the current one.
  const withoutOld = existing.replace(/machine api\.mapbox\.com\n(?:[ \t].*\n?){0,2}/g, "")
  const block = `machine api.mapbox.com\n  login mapbox\n  password ${token}\n`
  const next = `${withoutOld.replace(/\n*$/, "")}\n${block}`.replace(/^\n+/, "")

  await writeFile(netrcPath, next)
  await chmod(netrcPath, 0o600)
  console.log("  ~/.netrc updated with Mapbox SPM credentials (from environment)")
}

export function resolveBuildUser({
  githubActor = process.env.GITHUB_ACTOR,
  readGitUsername = () =>
    execFileSync("git", ["config", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
} = {}) {
  const actor = githubActor?.trim()
  if (actor) return actor.replace(/\s+/g, "_")

  try {
    const username = readGitUsername().trim()
    return username ? username.replace(/\s+/g, "_") : "unknown"
  } catch {
    return "unknown"
  }
}

export async function setBuildEnv() {
  // Keep src/generated/bundledMiniapps.ts in sync with assets/miniapps/*.zip
  // before any prebuild/bundle so newly-dropped bundles get shipped.
  await generateBundledMiniapps()

  // If running under `doppler run`, mirror the Mapbox sk. token into ~/.netrc
  // for iOS SPM. No-op otherwise (manual-setup developers untouched).
  await syncMapboxNetrc()

  // Wipe the Gradle autolinking cache only when the resolved graph drifted
  // (see clear-autolinking-cache.mjs). MENTRA_FORCE_AUTOLINK_WIPE=1 restores
  // the old unconditional wipe.
  await syncAutolinkingCache()

  const gitCommit = (await $`git rev-parse --short HEAD`).stdout.trim()
  const gitBranch =
    process.env.MENTRA_COORDINATED_RELEASE_CHANNEL || (await $`git rev-parse --abbrev-ref HEAD`).stdout.trim()
  const gitUsername = resolveBuildUser()
  const buildTime = new Date()
    .toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/(\d+)\/(\d+)\/(\d+),\s+/, "$3-$1-$2_")
    .replace(/:/g, "-")
    .replace(/\s+/g, "")

  const buildVars = {
    EXPO_PUBLIC_BUILD_COMMIT: gitCommit,
    EXPO_PUBLIC_BUILD_BRANCH: gitBranch,
    EXPO_PUBLIC_BUILD_USER: gitUsername,
    EXPO_PUBLIC_BUILD_TIME: buildTime,
  }

  // console.log("Build environment set:")
  // Object.entries(buildVars).forEach(([key, value]) => {
  //   console.log(`  ${key}: ${value}`)
  //   process.env[key] = value
  // })

  // Snapshot which variables were already set in the real environment BEFORE
  // dotenv loads .env. Those keep their values (standard dotenv semantics:
  // explicit environment beats .env file). CI relies on this — it injects the
  // release-signing credentials (ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_*) as env
  // vars while its .env is a verbatim copy of .env.example; letting the file
  // win clobbered them with empty strings and silently downgraded staging
  // release builds to debug signing (broken Play internal uploads, June 2026).
  const inheritedEnv = new Set(Object.keys(process.env))

  // Load existing .env
  const existingEnv = config().parsed || {}

  // The Mapbox public access token (pk.…) injected by the environment (i.e.
  // `doppler run`) must win over the .env dummy value, so navigation works on the
  // opt-in Doppler path. Only a real token overrides — an absent or dummy env
  // value leaves .env in charge so the manual-setup fallback is untouched.
  //
  // NOTE: the Downloads:Read secret (MAPBOX_DOWNLOADS_TOKEN, sk.…) is
  // deliberately NOT merged here. It is a build-time-only credential that must
  // stay in process.env / ~/.netrc only — writing it into .env (and printing it
  // in the loop below) would persist and log a real secret. `syncMapboxNetrc`
  // already mirrors it to ~/.netrc for iOS SPM, and Android reads it from the
  // environment directly.
  const envOverrides = {}
  const mapboxPk = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN
  if (mapboxPk && mapboxPk.startsWith("pk.")) {
    envOverrides.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = mapboxPk
  }
  // The Mapbox Downloads:Read SECRET token (MAPBOX_DOWNLOADS_TOKEN, sk.…) is
  // deliberately NOT mirrored into .env. It's a build-time-only credential read
  // straight from the environment (Android Gradle via System.getenv) and from
  // ~/.netrc (iOS SPM, written by syncMapboxNetrc above). Persisting it to .env
  // would write a live secret to disk and echo it in the build log below.

  // Merge with build vars (env-injected real tokens take highest precedence).
  const updatedEnv = {...existingEnv, ...buildVars, ...envOverrides}

  // Belt-and-suspenders: never let a real sk.… Downloads token reach .env, even
  // if a prior run or a hand-edit left one in the existing file. The ci/dev
  // dummy ("sk-ci-dummy-…", a hyphen not a dot) is preserved.
  if (
    typeof updatedEnv.MAPBOX_DOWNLOADS_TOKEN === "string" &&
    updatedEnv.MAPBOX_DOWNLOADS_TOKEN.startsWith("sk.")
  ) {
    delete updatedEnv.MAPBOX_DOWNLOADS_TOKEN
  }

  // Write env to process.env. buildVars are computed fresh for this build and
  // always apply; every other key only fills a gap — a variable that was
  // already set in the environment keeps its value (its actual value is not
  // echoed either, since env-injected values can be secrets).
  Object.entries(updatedEnv).forEach(([key, value]) => {
    if (key in buildVars || !inheritedEnv.has(key)) {
      process.env[key] = value
      console.log(`  ${key}: ${value}`)
    } else {
      console.log(`  ${key}: (kept from environment)`)
    }
  })

  // Write back to .env
  const envContent =
    Object.entries(updatedEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"

  await writeFile(".env", envContent)

  console.log("\n.env file updated successfully")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await setBuildEnv()
}
