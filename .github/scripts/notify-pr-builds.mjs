import {iosReceiptName, validateIosReceipt} from "./pr-ios-artifacts.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

export function iosBuildRequired(files) {
  return files.some(
    ({filename}) =>
      filename.startsWith("mobile/") ||
      filename === ".github/workflows/mentra-app-ios-build.yml" ||
      filename.startsWith(".github/scripts/pr-ios-artifacts"),
  )
}

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const link = (url, label) => `<${url}|${escape(label).replaceAll("|", " ")}>`
const marker = "<!-- mentra-pr-builds-slack -->"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function readOtaTargets(manifest, number, sha) {
  if (manifest.releaseVersion !== `pr-${number}-${sha}`)
    throw new Error("OTA manifest belongs to a different PR revision")
  const asg = manifest.apps?.["com.mentra.asg_client"]
  const bes = manifest.bes_firmware
  const mtk = manifest.mtk_full_ota
  if (
    !asg?.versionName ||
    !Number.isSafeInteger(asg.versionCode) ||
    asg.versionCode <= 0 ||
    !/^[a-f0-9]{64}$/i.test(asg.sha256 ?? "") ||
    !Number.isSafeInteger(asg.apkSize) ||
    asg.apkSize <= 0 ||
    !/^https:\/\//.test(asg.apkUrl ?? "") ||
    !bes?.version ||
    !mtk?.end_firmware
  ) {
    throw new Error("OTA manifest is missing ASG, BES or MTK target metadata")
  }
  return {asg, bes: bes.version, mtk: mtk.end_firmware}
}

export function buildPost({pr, sha, androidUrl, manifestUrl, targets, androidRunUrl, asgRunUrl, error, ios}) {
  const ready = !error && !ios?.error
  const title = ready ? "✅ PR build ready to test" : "⚠️ PR build incomplete"
  const lines = [
    `*${title}*`,
    link(pr.html_url, `#${pr.number} — ${pr.title}`),
    `${escape(pr.head.ref)} → ${escape(pr.base.ref)} · by ${escape(pr.user.login)} · commit \`${sha.slice(0, 7)}\``,
  ]
  if (!error) {
    lines.push(`📱 *Android* — ${link(androidUrl, "Download APK")}\nBackend: *Dev* · Android ARM64`)
    lines.push(
      `🕶️ *Glasses OTA — ready*\n*ASG:* ${escape(targets.asg.versionName)} · build ${
        targets.asg.versionCode
      }\n*BES:* ${escape(targets.bes)}\n*MTK:* ${escape(targets.mtk)}\n${link(manifestUrl, "OTA manifest")} · ${link(
        targets.asg.apkUrl,
        "ASG APK",
      )}`,
    )
    lines.push(
      "Install the APK, connect your Mentra Live glasses, and follow the update prompt if shown. This app targets the versions above.",
    )
  } else {
    lines.push(escape(error))
  }
  if (ios?.assets) {
    lines.push(
      `📱 *iPhone* — ${link(ios.assets.iphone, "Download IPA")}\n🖥️ *Mac* — ${link(
        ios.assets.mac,
        "Download app",
      )}\nRegistered devices only · Backend: *Dev* · ${link(ios.instructionsUrl, "Installation instructions")}`,
    )
  } else if (ios?.error) lines.push(`*iPhone / Mac:* ${escape(ios.error)}`)
  else if (ios) lines.push("*iPhone / Mac:* not built for these changed paths.")
  if (ios?.runUrl) lines.push(link(ios.runUrl, "iOS build logs"))
  lines.push(
    `${link(pr.html_url, "View PR and checks")} · ${link(androidRunUrl, "Android build logs")}${
      asgRunUrl ? ` · ${link(asgRunUrl, "ASG build logs")}` : ""
    }`,
  )
  if (ready) lines.push("Downloads may be cleaned up after 7 days.")
  return {
    text: `${title}: #${pr.number} ${pr.title} (${sha.slice(0, 7)})`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: lines.map((text) => ({type: "section", text: {type: "mrkdwn", text}})),
  }
}

export function matchingAsgRun(runs, pr, sha) {
  return runs
    .filter(
      (run) =>
        run.event === "pull_request" &&
        run.head_sha === sha &&
        run.head_branch === pr.head.ref &&
        run.head_repository?.full_name === pr.head.repo.full_name,
    )
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0]
}

export async function notifyPrBuilds({github, context, core, fetchImpl = fetch, wait = sleep, attempts = 240}) {
  const webhook = process.env.SLACK_WEBHOOK_PR_BUILDS
  if (!webhook) throw new Error("SLACK_WEBHOOK_PR_BUILDS is missing; configure the #pr-builds incoming webhook")
  const repo = context.repo
  let pr = context.payload.pull_request
  const sha = pr.head.sha
  const androidRunUrl = `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`
  const current = async () => {
    pr = (await github.rest.pulls.get({...repo, pull_number: pr.number})).data
    return pr.state === "open" && pr.head.sha === sha
  }
  if (!(await current())) {
    core.info("PR closed or superseded; no notification.")
    return
  }
  let error =
    process.env.ANDROID_RESULT === "success"
      ? null
      : `Android build ${process.env.ANDROID_RESULT}; no ready-to-test build is available.`
  const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: pr.number, per_page: 100})
  const ios = {required: iosBuildRequired(files)}
  let asgRun, iosRun
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!(await current())) {
      core.info("PR superseded while awaiting publication.")
      return
    }
    const find = async (workflow_id) => {
      const {data} = await github.rest.actions.listWorkflowRuns({
        ...repo,
        workflow_id,
        head_sha: sha,
        event: "pull_request",
        per_page: 100,
      })
      return matchingAsgRun(data.workflow_runs, pr, sha)
    }
    ;[asgRun, iosRun] = await Promise.all([
      error ? undefined : find("mentra-asg-client-build.yml"),
      ios.required ? find("mentra-app-ios-build.yml") : undefined,
    ])
    if (asgRun?.conclusion === "cancelled" || iosRun?.conclusion === "cancelled") {
      core.info("A matching workflow was cancelled; no notification.")
      return
    }
    if ((error || asgRun?.status === "completed") && (!ios.required || iosRun?.status === "completed")) break
    core.info("Waiting for this PR revision's ASG and applicable iOS publication.")
    await wait(30_000)
  }
  if (!error && asgRun?.conclusion !== "success")
    error = `ASG + OTA ${
      asgRun?.conclusion || "did not complete before the notification timeout"
    }; Android is not ready to test.`
  if (ios.required) {
    ios.runUrl = iosRun?.html_url
    if (iosRun?.conclusion !== "success")
      ios.error = `iOS ${
        iosRun?.conclusion || "did not complete before the notification timeout"
      }; downloads are not ready.`
  }
  const base = `https://artifactscdn.mentraglass.com/${repo.owner}/${repo.repo}/releases/pr-builds`
  const androidUrl = `${base}/mobile-pr-${pr.number}-${sha.slice(0, 7)}.apk`
  const manifestUrl = `${base}/ota-pr-${pr.number}-${sha}.json`
  let targets
  const request = async (url, method = "GET") => {
    const response = await fetchImpl(url, {method, signal: AbortSignal.timeout(60_000)})
    if (!response.ok) throw new Error(`Published artifact unavailable (${response.status}): ${url}`)
    return response
  }
  if (!error) {
    try {
      targets = readOtaTargets(await (await request(manifestUrl)).json(), pr.number, sha)
      await request(androidUrl, "HEAD")
      const asg = await request(targets.asg.apkUrl, "HEAD")
      const size = asg.headers.get("content-length")
      if (size && Number(size) !== targets.asg.apkSize)
        throw new Error("Published ASG APK size disagrees with its manifest")
    } catch (failure) {
      error = failure.message
    }
  }
  if (ios.required && !ios.error) {
    try {
      const coordinates = {pr: pr.number, sha, runId: iosRun.id, attempt: iosRun.run_attempt}
      const receiptUrl = artifactUrl(
        `${repo.owner}/${repo.repo}`,
        "pr-builds",
        iosReceiptName(pr.number, sha, iosRun.id, iosRun.run_attempt),
      )
      const receipt = await (await request(receiptUrl)).json()
      const assets = validateIosReceipt(receipt, coordinates)
      const urls = {}
      for (const [kind, asset] of Object.entries(assets)) {
        urls[kind] = artifactUrl(`${repo.owner}/${repo.repo}`, "pr-builds", asset.name)
        const response = await request(urls[kind], "HEAD")
        if (Number(response.headers.get("content-length")) !== asset.size)
          throw new Error(`Published ${kind} download size disagrees with its receipt`)
      }
      ios.assets = urls
      ios.instructionsUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${receipt.buildSha}/mobile/ci/pr-ios/README.md`
    } catch (failure) {
      ios.error = failure.message
    }
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: pr.number,
    per_page: 100,
  })
  const comment = comments.find((item) => item.user?.type === "Bot" && item.body?.startsWith(marker))
  const incomplete = Boolean(error || ios.error)
  const identity = `${sha}:${incomplete ? "incomplete" : "ready"}:ios-${iosRun?.id || "skipped"}-${
    iosRun?.run_attempt || 0
  }`
  if (comment?.body.includes(`<!-- ${identity} -->`)) {
    core.info("This PR revision's notification was already delivered.")
    return
  }
  if (!(await current())) {
    core.info("PR superseded before notification.")
    return
  }
  const payload = buildPost({
    pr,
    sha,
    androidUrl,
    manifestUrl,
    targets,
    androidRunUrl,
    asgRunUrl: asgRun?.html_url,
    error,
    ios,
  })
  // No automatic POST retry: an ambiguous network failure must not duplicate a post.
  const response = await fetchImpl(webhook, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok || (await response.text()).trim() !== "ok")
    throw new Error(`Slack rejected the PR build notification (${response.status})`)
  const downloads = [error || `[Download Android APK](${androidUrl}) · [Glasses OTA manifest](${manifestUrl})`]
  if (ios.assets)
    downloads.push(
      `[Download iPhone IPA](${ios.assets.iphone}) · [Download Mac app](${ios.assets.mac}) · [Installation instructions](${ios.instructionsUrl})`,
    )
  else downloads.push(ios.error || "iPhone / Mac: not built for these changed paths.")
  const body = `${marker}\n<!-- ${identity} -->\n${
    incomplete ? "⚠️ PR build incomplete" : "✅ PR build ready to test"
  } for \`${sha.slice(0, 7)}\` — posted to **#pr-builds**.\n\n${downloads.join(
    "\n\n",
  )}\n\n[Android build logs](${androidRunUrl})${ios.runUrl ? ` · [iOS build logs](${ios.runUrl})` : ""}`

  if (comment) await github.rest.issues.updateComment({...repo, comment_id: comment.id, body})
  else await github.rest.issues.createComment({...repo, issue_number: pr.number, body})
  core.info(`Delivered ${identity} to #pr-builds`)
  if (error) core.warning(error)
  if (ios.error) core.warning(ios.error)
}
