#!/usr/bin/env node
// The dev, staging or production release's post to its builds channel (release.yml's
// notify-slack), in the layout of every build post (slack-build-post.mjs).
// SLACK_NOTIFY_DRY_RUN=true prints the payload instead of posting it.
import path from "node:path"
import {fileURLToPath} from "node:url"
import {buildPost, DOCS, otaTargets, postToWebhook, slackText} from "./slack-build-post.mjs"

const CHANNELS = {
  dev: {label: "Dev", webhook: "DEV_SLACK_WEBHOOK_URL"},
  staging: {label: "Staging", webhook: "STAGING_SLACK_WEBHOOK_URL"},
  // A production release is announced with the betas it promotes.
  production: {label: "Production", webhook: "STAGING_SLACK_WEBHOOK_URL"},
}
// Why a slot has no install, from the job that builds it.
const MISSING = {failure: "failed", timed_out: "timed out", cancelled: "cancelled", skipped: "not built", success: "not published"}

// The release's jobs, as release.yml passes their results. The Mentra release (Cloud V2, the Mentra App,
// Engine, the Bluetooth SDK) is complete when finalize succeeds; the others never make it incomplete.
const CHECKS = [
  ["PLAN_RESULT", "Plan"],
  ["CLOUD_V2_RESULT", "Cloud V2"],
  ["RUNTIME_IMAGE_RESULT", "Mentra Cloud image"],
  ["PRIVATE_DEPLOYMENT_RESULT", "Private deployment"],
  ["OTA_RESULT", "ASG + OTA"],
  ["NPM_RESULT", "Packages"],
  ["SDK_NATIVE_RESULT", "Native SDK"],
  ["ENGINE_RESULT", "Engine consumer"],
  ["ANDROID_RESULT", "Android"],
  ["IOS_RESULT", "iOS"],
  ["RELEASE_PAGE_RESULT", "Download page"],
  ["EXAMPLES_RESULT", "Bluetooth example builds"],
  ["EXAMPLE_TESTFLIGHT_RESULT", "Bluetooth example TestFlight"],
  ["EXAMPLE_GOOGLE_PLAY_RESULT", "Bluetooth example Google Play"],
  ["DOCS_RESULT", "Docs"],
]
const UNFINISHED = {failure: "Failed", timed_out: "Timed out", cancelled: "Cancelled"}

/** An HTTPS download that answers, after two retries. */
export async function reachable(url, fetchImpl = fetch) {
  if (!url?.startsWith("https://")) return false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if ((await fetchImpl(url, {method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20_000)})).ok) return true
    } catch { /* retried */ }
  }
  return false
}

/** A platform's install: the first of `urls` that answers, else why there is none, from its job's `result` (none: no job builds it). */
async function slot(platform, urls, result, check) {
  const answers = await Promise.all(urls.map((url) => (url ? check(url) : false)))
  const url = urls.find((_, index) => answers[index])
  return {platform, url, missing: MISSING[result] ?? "not built"}
}

/** Report the failed job and step, never raw build logs or provider error bodies. */
export async function releaseFailureDetail(env, fetchImpl = fetch) {
  const fallback = env.MAC_URL || env.MOBILE_APK_URL || env.MOBILE_ASSET_BASE_URL
    ? "The release did not complete successfully."
    : "The release did not publish an installable app build."
  // The repository whose run built the release: the Mentra monorepo releases into MentraOS's ledger from its own runs.
  const runRepository = env.RUN_REPOSITORY || env.REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(runRepository ?? "") || !/^[1-9]\d*$/.test(env.RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.RUN_ATTEMPT ?? "")) return {text: fallback}
  const run = `https://github.com/${runRepository}/actions/runs/${env.RUN_ID}`
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${runRepository}/actions/runs/${env.RUN_ID}/attempts/${env.RUN_ATTEMPT}/jobs?per_page=100`, {
      headers: {Accept: "application/vnd.github+json", ...(env.GH_TOKEN ? {Authorization: `Bearer ${env.GH_TOKEN}`} : {})},
      redirect: "error", signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error("Job metadata unavailable")
    const {jobs} = await response.json()
    const failed = jobs.filter(job => Object.hasOwn(UNFINISHED, job.conclusion))
    const job = failed.find(job => job.name.endsWith("Build and distribute coordinated iOS app")) ??
      failed.find(job => job.name.endsWith("Prepare immutable mobile release")) ?? failed[0]
    if (job && Number.isSafeInteger(job.id) && job.id > 0) {
      const step = job.steps?.find(step => Object.hasOwn(UNFINISHED, step.conclusion))
      const stage = job.name.endsWith("Build and distribute coordinated iOS app") ? "iOS/Mac build" : slackText(job.name.split(" / ").at(-1), 180)
      const outcome = {failure: "failed", timed_out: "timed out", cancelled: "was cancelled"}[job.conclusion]
      return {text: `${stage} ${outcome}${step ? ` during “${slackText(step.name, 180)}”` : ""}.`, url: `${run}/job/${job.id}`}
    }
  } catch { /* The post must survive a GitHub API outage. */ }
  return {text: fallback, url: `${run}/attempts/${env.RUN_ATTEMPT}`}
}

async function glasses(env, fetchImpl) {
  if (!env.OTA_MANIFEST_URL) return {}
  try {
    const response = await fetchImpl(env.OTA_MANIFEST_URL, {signal: AbortSignal.timeout(20_000)})
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return {glasses: otaTargets(await response.json(), env.RELEASE_IDENTITY)}
  } catch (error) {
    return {glassesNote: `Glasses versions unavailable (${error.message})`}
  }
}

/** The release post's payload. `check` answers whether a download URL is published. */
export async function releasePost(env, {check = reachable, fetchImpl = fetch} = {}) {
  const {label} = CHANNELS[env.BRANCH]
  const identity = env.RELEASE_IDENTITY || "unknown"
  const runUrl = `https://github.com/${env.RUN_REPOSITORY || env.REPOSITORY}/actions/runs/${env.RUN_ID}`
  const pageFailed = ["failure", "cancelled"].includes(env.RELEASE_PAGE_RESULT)
  const details = identity === "unknown" ? runUrl
    // Without its page, the release's files are still in the artifact container's release.
    : `https://github.com/${env.REPOSITORY}/releases/tag/${pageFailed ? `mentra-builds-v${identity.replace(/-[^-]*$/, "")}` : `mentra-v${identity}`}`
  const android = env.ANDROID_RESULT || env.MOBILE_RESULT
  const ios = env.IOS_RESULT || env.MOBILE_RESULT
  const name = identity === "unknown" ? "(identity allocation failed)" : slackText(identity, 80)
  const [title, summary] = env.FINALIZE_RESULT === "success" ? [`*✅ ${label} ${name} released*`, "released"]
    : [android, ios, env.OTA_RESULT].includes("success") ? [`*⚠️ ${label} release ${name} incomplete*`, "incomplete"]
      : [`*❌ ${label} release ${name} failed*`, "failed"]

  const apk = env.MOBILE_APK_URL || (env.MOBILE_ASSET_BASE_URL && env.APK_NAME ? `${env.MOBILE_ASSET_BASE_URL}/${env.APK_NAME}` : undefined)
  const apple = env.IPHONE_MANIFEST_URL && (await Promise.all([env.IPHONE_MANIFEST_URL, env.IPHONE_SHARE_URL, env.MAC_URL].map(check))).every(Boolean)
  // Android and iOS for each app, the store's install when the build has no page of its own, then macOS.
  const [mentra, example, ota, problem] = await Promise.all([
    Promise.all([
      slot("Android", [apk, env.PLAY_INSTALL_URL], android, check),
      // TestFlight once testers can install it, not while its beta review is pending or skipped.
      slot("iOS", [env.TESTFLIGHT_DISTRIBUTION_STATUS === "available" ? env.TESTFLIGHT_INSTALL_URL : undefined,
        apple ? env.IPHONE_SHARE_URL : undefined], ios, check),
      slot("macOS", [apple ? env.MAC_URL : undefined], ios, check),
    ]),
    Promise.all([
      slot("Android", [env.EXAMPLE_APK_URL, env.EXAMPLE_GOOGLE_PLAY_INSTALL_URL], env.EXAMPLES_RESULT, check),
      slot("iOS", [env.EXAMPLE_TESTFLIGHT_INSTALL_URL, env.EXAMPLE_IPHONE_SHARE_URL], env.EXAMPLE_TESTFLIGHT_RESULT, check),
      // No release job builds the example for macOS yet.
      slot("macOS", [env.EXAMPLE_MAC_URL], undefined, check),
    ]),
    glasses(env, fetchImpl),
    env.FINALIZE_RESULT === "success" || env.RELEASE_SCOPE === "examples" ? undefined : releaseFailureDetail(env, fetchImpl),
  ])
  const unfinished = Object.entries(UNFINISHED).flatMap(([result, word]) => {
    const names = CHECKS.filter(([key]) => env[key] === result).map(([, check]) => check)
    return names.length ? [`*${word}:* ${names.join(", ")}`] : []
  })
  return buildPost({
    text: `Mentra ${env.BRANCH} release ${identity} ${summary}`,
    title,
    details,
    facts: [
      `${(env.SHA ?? "").slice(0, 7)} ${(env.COMMIT_MESSAGE || "Commit metadata unavailable").split("\n")[0]}`.trim(),
      `by ${env.COMMIT_AUTHOR || "unknown"}`,
      // The build numbers Google Play Console and App Store Connect show.
      ...(env.ANDROID_VERSION_CODE ? [`Android ${env.ANDROID_VERSION_CODE}`] : []),
      ...(env.IOS_BUILD_NUMBER ? [`iOS ${env.IOS_BUILD_NUMBER}`] : []),
    ],
    apps: [{name: "Mentra", installs: mentra}, {name: "Bluetooth example", installs: example}],
    docs: DOCS[env.BRANCH],
    ...ota,
    problems: [
      ...(problem ? [{text: `*Release did not finish:* ${problem.text}`, url: problem.url}] : []),
      ...(unfinished.length ? [{text: unfinished.join(" · "), url: runUrl}] : []),
    ],
  })
}

export async function notifyRelease(env = process.env, options = {}) {
  const channel = CHANNELS[env.BRANCH]
  if (!channel) return console.log(`::warning::No release Slack channel is configured for branch ${env.BRANCH || "<unknown>"}.`)
  const webhook = env[channel.webhook]
  const payload = await releasePost(env, options)
  if (env.SLACK_NOTIFY_DRY_RUN === "true") return console.log(JSON.stringify(payload))
  if (!webhook) return console.log(`::warning::${channel.webhook} is not set; skipping the ${channel.label} release post.`)
  await postToWebhook(webhook, payload, options.fetchImpl)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await notifyRelease()
