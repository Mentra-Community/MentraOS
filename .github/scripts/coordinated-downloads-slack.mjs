import {execFileSync} from "node:child_process"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {iosInstallUrl} from "./pr-ios-artifacts-install.mjs"
import {publishedCoordinatedBuild} from "./coordinated-routine-request.mjs"

const text = (value) => ({type: "text", text: value})
const link = (url, label) => ({type: "link", url, text: label})
const reachable = (url) => {
  if (!url?.startsWith("https://")) return false
  try {
    execFileSync("curl", ["--fail", "--silent", "--head", "--location", "--max-time", "20", "--retry", "2", url], {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

export function platformDownloads(env, check = reachable) {
  const apple = [env.IPHONE_MANIFEST_URL, env.IPHONE_SHARE_URL, env.MAC_URL].every((url) => check(url))
  const apk =
    env.MOBILE_APK_URL || (env.MOBILE_ASSET_BASE_URL && env.APK_NAME && `${env.MOBILE_ASSET_BASE_URL}/${env.APK_NAME}`)
  const ipa =
    env.MOBILE_IPA_URL || (env.MOBILE_ASSET_BASE_URL && env.IPA_NAME && `${env.MOBILE_ASSET_BASE_URL}/${env.IPA_NAME}`)
  const rows = [
    ["iphone", "Android", check(apk) ? [link(apk, "Download APK")] : []],
    [
      "iphone",
      "iOS",
      apple
        ? [
            link(iosInstallUrl(env.IPHONE_MANIFEST_URL), "Install on iPhone"),
            link(env.IPHONE_SHARE_URL, "Share install link"),
          ]
        : // Preserve useful historical store-IPA links on old-release notifications.
          !env.IPHONE_MANIFEST_URL && check(ipa)
          ? [link(ipa, "Download IPA")]
          : [],
    ],
    ["computer", "macOS", apple ? [link(env.MAC_URL, "Download ZIP")] : []],
  ]
  return [
    {
      type: "rich_text",
      elements: rows.map(([icon, name, links]) => ({
        type: "rich_text_section",
        elements: [
          {type: "emoji", name: icon},
          {...text(` ${name}`), style: {bold: true}},
          text(" — "),
          ...(links.length
            ? links.flatMap((item, index) => (index ? [text(" · "), item] : [item]))
            : [text("Downloads unavailable")]),
        ],
      })),
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Backend: *${env.BRANCH === "staging" ? "Staging" : "Dev"}* · Android ARM64${apple ? " · Apple devices must be registered" : ""}`,
        },
      ],
    },
  ]
}

export function otaTargetText(manifest, identity) {
  const asg = manifest.apps?.["com.mentra.asg_client"]
  if (
    manifest.releaseVersion !== identity ||
    !asg?.versionName ||
    !Number.isSafeInteger(asg.versionCode) ||
    asg.versionCode <= 0 ||
    !manifest.bes_firmware?.version ||
    !manifest.mtk_full_ota?.end_firmware
  )
    throw new Error("OTA targets do not match this coordinated release")
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return `ASG: *${escape(asg.versionName)}* · build ${asg.versionCode}\nBES: *${escape(manifest.bes_firmware.version)}*\nMTK: *${escape(manifest.mtk_full_ota.end_firmware)}*`
}

/** Report the failed job/step, never raw build logs or provider error bodies. */
export async function releaseFailureDetail(env, fetchImpl = fetch) {
  const fallback = env.MAC_URL
    ? "Not requested: the release did not complete successfully."
    : "Not requested: the release did not publish an installable iOS/Mac build."
  if (env.REPOSITORY !== "Mentra-Community/MentraOS" || !/^[1-9]\d*$/.test(env.RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.RUN_ATTEMPT ?? "")) return fallback
  const run = `https://github.com/${env.REPOSITORY}/actions/runs/${env.RUN_ID}`
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${env.REPOSITORY}/actions/runs/${env.RUN_ID}/attempts/${env.RUN_ATTEMPT}/jobs?per_page=100`, {
      headers: {Accept: "application/vnd.github+json", ...(env.GH_TOKEN ? {Authorization: `Bearer ${env.GH_TOKEN}`} : {})},
      redirect: "error", signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error("Job metadata unavailable")
    const {jobs} = await response.json()
    const failed = jobs.filter(job => ["failure", "timed_out", "cancelled"].includes(job.conclusion))
    const job = failed.find(job => job.name.endsWith("Build and distribute coordinated iOS app")) ??
      failed.find(job => job.name.endsWith("Prepare immutable mobile release")) ?? failed[0]
    if (job && Number.isSafeInteger(job.id) && job.id > 0) {
      const clean = value => String(value).replace(/[\r\n]/g, " ").slice(0, 180)
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      const step = job.steps?.find(step => ["failure", "timed_out", "cancelled"].includes(step.conclusion))
      const stage = job.name.endsWith("Build and distribute coordinated iOS app") ? "iOS/Mac build" : clean(job.name.split(" / ").at(-1))
      const outcome = {failure: "failed", timed_out: "timed out", cancelled: "was cancelled"}[job.conclusion]
      return `Not requested: ${stage} ${outcome}${step ? ` during “${clean(step.name)}”` : ""}. <${run}/job/${job.id}|View failed job>`
    }
  } catch { /* Notification delivery must survive a GitHub API outage. */ }
  return `${fallback} <${run}/attempts/${env.RUN_ATTEMPT}|View release jobs>`
}

/** Posted with the existing release notification, before its completion callback.
 * A request or release success is never reported as a device-test outcome. */
export async function coordinatedRoutineLinks(env, fetchImpl = fetch) {
  if (!["dev", "staging"].includes(env.BRANCH) || env.RELEASE_SCOPE === "examples") return []
  const pipeline = new URL("https://github.com/Mentra-Community/MentraOS/actions/workflows/dispatch-device-routine.yml")
  if (/^[1-9]\d*$/.test(env.RUN_ID ?? "") && /^[1-9]\d*$/.test(env.RUN_ATTEMPT ?? ""))
    pipeline.searchParams.set("query", `\"Device request callback ${env.RUN_ID} / attempt ${env.RUN_ATTEMPT}\"`)
  let detail
  let results = ""
  if (env.FINALIZE_RESULT === "success" && env.MAC_URL && env.REPOSITORY === "Mentra-Community/MentraOS") {
    try {
      const selection = await publishedCoordinatedBuild({identity: env.RELEASE_IDENTITY, channel: env.BRANCH, sourceCommit: env.SHA, fetchImpl})
      if (selection.archive.url !== env.MAC_URL) throw new Error("Notification refers to another Mac archive")
      const url = new URL("https://admin.dev.mentraglass.com/")
      url.search = new URLSearchParams({testRuns: "1", channel: env.BRANCH, repository: env.REPOSITORY, headSha: env.SHA,
        archiveSha256: selection.archive.sha256, routineId: "no-glasses", platform: "ios-mac"}).toString()
      results = ` · <${url.href}|Results for this exact build>`
      // Finalize already depends on the core release jobs. These sibling jobs can
      // still fail afterward, preventing the successful-workflow callback.
      detail = ["FINALIZE_RESULT", "RELEASE_PAGE_RESULT", "EXAMPLES_DISPATCH_RESULT"].every(key => env[key] === "success")
        ? "Automatic request follows successful workflow completion; execution and results are pending."
        : await releaseFailureDetail(env, fetchImpl)
    } catch { detail = "Not requested: the published Mac download could not be verified. Inspect the release publication job." }
  }
  if (!detail) detail = await releaseFailureDetail(env, fetchImpl)
  const botConfigured = env.SLACK_BUILDS_BOT_TOKEN && /^C[A-Z0-9]+$/.test(env.BRANCH === "dev"
    ? env.SLACK_DEV_BUILDS_CHANNEL_ID ?? "" : env.SLACK_STAGING_BUILDS_CHANNEL_ID ?? "")
  const updates = botConfigured ? "" : "\nSlack result updates are not configured; use the results link when available."
  return [{type: "section", block_id: "mentra-release-routines", text: {type: "mrkdwn", text:
    `*Requested tests*\nNo-glasses UI — ${detail}\n<${pipeline.href}|Request pipeline>${results}${updates}`}}]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "platforms") console.log(JSON.stringify(platformDownloads(process.env)))
  else if (process.argv[2] === "routines") console.log(JSON.stringify(await coordinatedRoutineLinks(process.env)))
  else if (process.argv[2] === "ota") {
    try {
      const response = await fetch(process.env.OTA_MANIFEST_URL, {signal: AbortSignal.timeout(20_000)})
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      console.log(otaTargetText(await response.json(), process.env.RELEASE_IDENTITY))
    } catch (error) {
      console.log(`OTA target details unavailable (${error.message})`)
    }
  } else throw new Error("Expected platforms or ota")
}
