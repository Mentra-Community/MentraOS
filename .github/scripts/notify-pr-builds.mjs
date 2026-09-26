import {androidReceiptName, validateAndroidReceipt} from "./pr-android-artifacts.mjs"
import {MOBILE_PR_PATHS, prBackend} from "./pr-mobile-build.mjs"
import {createHash} from "node:crypto"
import {iosInstallUrl, macInstallPageUrl} from "./pr-ios-artifacts-install.mjs"
import {iosReceiptName, validateIosReceipt} from "./pr-ios-artifacts.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"
import {DEVICE_ROUTINES, deviceRoutine, hasRoutineLabel} from "./device-routines.mjs"

export function iosBuildRequired(files) {
  return files.some(({filename}) =>
    MOBILE_PR_PATHS.some((pattern) =>
      pattern.endsWith("*") ? filename.startsWith(pattern.replace(/\*+$/, "")) : filename === pattern,
    ),
  )
}

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const link = (url, label) => `<${url}|${escape(label).replaceAll("|", " ")}>`
const marker = "<!-- mentra-pr-builds-slack -->"
const iosTextTypes = {install: "text/html", manifest: "text/xml"}

export async function verifyIosTextArtifact(response, kind, asset) {
  if (response.headers.get("content-type")?.split(";")[0] !== iosTextTypes[kind])
    throw new Error(`Published ${kind} has an incorrect content type`)
  // Fetch decodes CDN compression. Content-Length may be absent or describe
  // compressed bytes, while the receipt describes the original uploaded file.
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== asset.size) throw new Error(`Published ${kind} download size disagrees with its receipt`)
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error(`Published ${kind} download hash disagrees with its receipt`)
  return kind === "install" && bytes.toString("utf8").includes('data-mentra-mac-install="1"')
}

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

const backendName = (backend) => (backend === "staging" ? "Staging" : "Dev")

/** `backend` is shown only when a published receipt verified it for this PR's destination. */
export function buildPost({pr, sha, androidUrl, manifestUrl, targets, androidRunUrl, asgRunUrl, error, ios, routines = [],
  backend, unverifiedBackend = []}) {
  const ready = !error && !ios?.error
  const title = ready ? "✅ PR build ready to test" : "⚠️ PR build incomplete"
  const lines = [
    `*${title}*`,
    link(pr.html_url, `#${pr.number} — ${pr.title}`),
    `${escape(pr.head.ref)} → ${escape(pr.base.ref)} · by ${escape(pr.user.login)} · commit \`${sha.slice(0, 7)}\``,
  ]
  const appleStatus = ios?.error ? "Unavailable" : "Not built for these changes"
  const richLink = (url, text) => ({type: "link", url, text})
  const iphoneLinks = []
  if (ios?.assets) {
    if (ios.assets.install)
      iphoneLinks.push(
        richLink(iosInstallUrl(ios.assets.manifest), "Install on iPhone"),
        richLink(ios.assets.install, "Share install link"),
      )
    else iphoneLinks.push(richLink(ios.assets.iphone, "Download IPA"))
  }
  const macLinks = ios?.assets
    ? [
        ...(ios.macInstallUrl ? [richLink(ios.macInstallUrl, "Install on Mac")] : []),
        richLink(ios.assets.mac, ios.macInstallUrl ? "First-time setup ZIP" : "Download ZIP"),
      ]
    : []
  // Slack's webhook mrkdwn parser escapes itms-services links as literal text.
  // Rich-text links open the installer on iPhone; Slack renders them as plain
  // text on Mac, so also include the HTTPS installation page for sharing.
  // Mac installation uses HTTPS too; the browser performs the custom-protocol
  // handoff instead of depending on Slack's handling of a new URL scheme.
  const platforms = {
    type: "rich_text",
    elements: [
      ["iphone", "Android", error ? [] : [richLink(androidUrl, "Download APK")], "Unavailable"],
      ["iphone", "iOS", iphoneLinks, appleStatus],
      ["computer", "macOS", macLinks, appleStatus],
    ].map(([icon, name, links, status]) => ({
      type: "rich_text_section",
      elements: [
        {type: "emoji", name: icon},
        {type: "text", text: ` ${name}`, style: {bold: true}},
        {type: "text", text: " — "},
        ...(links.length
          ? links.flatMap((item, index) => (index ? [{type: "text", text: " · "}, item] : [item]))
          : [{type: "text", text: status}]),
      ],
    })),
  }
  if (error) lines.push(`*Android:* ${escape(error)}`)
  if (ios?.error) lines.push(`*iOS / macOS:* ${escape(ios.error)}`)
  if (!error || ios?.assets)
    lines.push(
      `Backend: ${backend ? `*${backendName(backend)}*` : "not verified"}${
        backend && unverifiedBackend.length ? ` (${unverifiedBackend.join(", ")} not verified)` : ""}${!error ? " · Android ARM64" : ""}${
        ios?.assets
          ? ` · Apple devices must be registered · ${link(ios.instructionsUrl, "Installation instructions")}`
          : ""
      }`,
    )
  if (!error) {
    lines.push(
      `🕶️ *Glasses OTA — ready*\n*ASG:* ${escape(targets.asg.versionName)} · build ${
        targets.asg.versionCode
      }\n*BES:* ${escape(targets.bes)}\n*MTK:* ${escape(targets.mtk)}\n${link(manifestUrl, "OTA manifest")} · ${link(
        targets.asg.apkUrl,
        "ASG APK",
      )}`,
    )
    lines.push(
      "Install the app, connect your Mentra Live glasses, and follow the update prompt if shown. This app targets the versions above.",
    )
  }
  for (const routine of routines)
    lines.push(
      `*Requested tests:* ${deviceRoutine(routine.id).name} · ${deviceRoutine(routine.id).platform === "android" ? "Android" : "iOS on Mac"}\n${[
        routine.resultsUrl ? link(routine.resultsUrl, "View results") : routine.resultsUnavailable || `Results link available with the ${deviceRoutine(routine.id).platform === "android" ? "Android" : "Mac"} build`,
        link(routine.pipelineUrl, routine.pipelineLabel),
      ].join(" · ")}\nResults appear after the device run is uploaded.`,
    )
  lines.push(
    `${link(pr.html_url, "View PR and checks")} · ${link(androidRunUrl, "Android build logs")}${
      ios?.runUrl ? ` · ${link(ios.runUrl, "iOS / macOS build logs")}` : ""
    }${asgRunUrl ? ` · ${link(asgRunUrl, "ASG build logs")}` : ""}`,
  )
  if (ready) lines.push("Downloads may be cleaned up after 7 days.")
  const blocks = lines.map((text) => ({type: "section", text: {type: "mrkdwn", text}}))
  blocks.splice(3, 0, platforms)
  return {
    text: `${title}: #${pr.number} ${pr.title} (${sha.slice(0, 7)})`,
    unfurl_links: false,
    unfurl_media: false,
    blocks,
  }
}

export function routineResultsUrl({repository, pr, sha, archiveSha256, routineId = "day1-ota"}) {
  if (
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(pr) ||
    pr <= 0 ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^[a-f0-9]{64}$/.test(archiveSha256 ?? "") || !Object.hasOwn(DEVICE_ROUTINES, routineId)
  )
    return null
  // Results are stored centrally regardless of the app backend. This is the deployed
  // admin origin documented in cloud-v2/docs/prds/admin-console.md, not the worker's UI.
  const url = new URL("https://admin.dev.mentraglass.com/")
  url.search = new URLSearchParams({
    testRuns: "1",
    repository,
    pr: String(pr),
    headSha: sha,
    archiveSha256,
    routineId,
    platform: DEVICE_ROUTINES[routineId].platform === "android" ? "android" : "ios-mac",
  }).toString()
  return url.href
}

async function requestedRoutineLinks({github, context, pr, sha, ios, android, core}) {
  const requested = Object.keys(DEVICE_ROUTINES).filter(id => hasRoutineLabel(pr, id))
  if (!requested.length) return []
  const repository = `${context.repo.owner}/${context.repo.repo}`
  const workflow = "request-e2e-routine.yml"
  const result = {
    pipelineUrl: `https://github.com/${repository}/actions/workflows/${workflow}`,
    pipelineLabel: "Request pipeline (workflow)",
  }
  try {
    const {data} = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: workflow,
      head_sha: sha,
      event: "pull_request",
      per_page: 100,
    })
    // One branch/head can back several PRs with different base branches. A
    // request belongs to a PR, so require its unambiguous Actions association.
    const associated = data.workflow_runs.filter(
      (run) => run.pull_requests?.length === 1 && run.pull_requests[0]?.number === pr.number,
    )
    const run = matchingBuildRun(associated, pr, sha)
    if (
      run &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0
    ) {
      result.pipelineUrl = `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`
      result.pipelineLabel = "Request pipeline"
    }
  } catch (error) {
    // Request creation and hardware are independent of build availability. A
    // missing/pending request or a lookup failure must not gate the build post.
    core.warning(`Could not locate this revision's routine request; linking its workflow: ${error.message}`)
  }
  return requested.map(id => ({...result, id,
    ...(DEVICE_ROUTINES[id].platform === "android" && android.receiptUnavailable
      ? {resultsUnavailable: "Android receipt unavailable; rerun the build notification to retry the results link."} : {}),
    resultsUrl: routineResultsUrl({repository, pr: pr.number, sha, archiveSha256: DEVICE_ROUTINES[id].platform === "android" ? android.archiveSha256 : ios.archiveSha256, routineId: id})}))
}

export function matchingBuildRun(runs, pr, sha) {
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

// Inspect artifact-producing jobs, not the whole workflow: its notification
// job can still be running or waiting for the shared concurrency lock. Pending
// notification jobs can also be superseded without cancelling a valid build.
const producers = {
  android: {workflow: "mentra-app-android-build.yml", jobs: ["build"]},
  asg: {workflow: "mentra-asg-client-build.yml", jobs: ["select", "build"]},
  ios: {workflow: "mentra-app-ios-build.yml", jobs: ["build", "publish"]},
}

async function readBuild(github, context, pr, sha, lane) {
  const producer = producers[lane]
  const {data} = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: producer.workflow,
    head_sha: sha,
    event: "pull_request",
    per_page: 100,
  })
  const run = matchingBuildRun(data.workflow_runs, pr, sha)
  if (!run || run.status === "queued") return {pending: true}
  // Failed-jobs reruns retain successful jobs from an earlier attempt. Select
  // the latest execution of each producer, excluding all notification jobs.
  const all = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: run.id,
    filter: "all",
    per_page: 100,
  })
  const jobs = producer.jobs.map(
    (name) =>
      all
        .filter((job) => job.name === name && job.run_attempt <= run.run_attempt)
        .sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)[0],
  )
  if (jobs.some((job) => !job || job.status !== "completed")) return {pending: true}
  // A downstream job from before a newly rerun dependency is stale. Also wait
  // while another workflow's new attempt has not exposed its producer jobs.
  if (
    jobs.some((job, index) => jobs.slice(0, index).some((upstream) => upstream.run_attempt > job.run_attempt)) ||
    (run.status !== "completed" && run.id !== context.runId && jobs.every((job) => job.run_attempt < run.run_attempt))
  )
    return {pending: true}
  const cancelled = jobs.some((job) => job.conclusion === "cancelled")
  const success = jobs.every(
    (job) => job.conclusion === "success" || (lane === "asg" && job.name === "build" && job.conclusion === "skipped"),
  )
  // GitHub copies retained successful jobs into a rerun with new IDs/attempts,
  // but keeps their execution timestamps. Use the first matching execution so
  // a notification-only retry still reads the original publication receipt.
  const last = jobs.at(-1)
  const attempt = Math.min(
    last.run_attempt,
    ...all
      .filter(
        (job) =>
          job.name === last.name &&
          job.started_at &&
          job.completed_at &&
          job.started_at === last.started_at &&
          job.completed_at === last.completed_at &&
          job.conclusion === last.conclusion,
      )
      .map((job) => job.run_attempt),
  )
  return {run, attempt, conclusion: cancelled ? "cancelled" : success ? "success" : "failure"}
}

export async function notifyPrBuilds({github, context, core, fetchImpl = fetch}) {
  const webhook = process.env.SLACK_WEBHOOK_PR_BUILDS
  if (!webhook) throw new Error("SLACK_WEBHOOK_PR_BUILDS is missing; configure the #pr-builds incoming webhook")
  const repo = context.repo
  let pr = context.payload.pull_request
  const sha = pr.head.sha
  // Snapshot the live destination. Artifacts are validated against it and a
  // retarget before sending suppresses the post instead of relabelling builds.
  let destination
  const current = async () => {
    pr = (await github.rest.pulls.get({...repo, pull_number: pr.number})).data
    destination ??= pr.base.ref
    return pr.state === "open" && pr.head.sha === sha && pr.base.ref === destination
  }
  if (!(await current())) {
    core.info("PR closed or superseded; no notification.")
    return
  }
  const backend = prBackend(destination)
  const mismatch = (platform, actual) =>
    `${platform} was built for ${["dev", "staging"].includes(actual) ? `the ${backendName(actual)}` : "an unrecorded"} backend, but this PR now targets ${destination}; rebuild it for this destination.`
  const files = await github.paginate(github.rest.pulls.listFiles, {...repo, pull_number: pr.number, per_page: 100})
  const ios = {required: iosBuildRequired(files)}
  const [androidBuild, asgBuild, iosBuild] = await Promise.all([
    readBuild(github, context, pr, sha, "android"),
    readBuild(github, context, pr, sha, "asg"),
    ios.required ? readBuild(github, context, pr, sha, "ios") : undefined,
  ])
  const builds = [androidBuild, asgBuild, iosBuild].filter(Boolean)
  if (builds.some((build) => build.pending)) {
    core.info("Build/publication still pending; its completion will reconcile the notification.")
    return
  }
  if (builds.some((build) => build.conclusion === "cancelled")) {
    core.info("An artifact-producing job was cancelled; no notification.")
    return
  }
  const androidRunUrl = androidBuild.run.html_url
  const asgRun = asgBuild.run
  const iosRun = iosBuild?.run
  let error =
    androidBuild.conclusion !== "success"
      ? `Android build ${androidBuild.conclusion}; no ready-to-test build is available.`
      : asgBuild.conclusion !== "success"
        ? `ASG + OTA ${asgBuild.conclusion}; Android is not ready to test.`
        : null
  if (ios.required) {
    ios.runUrl = iosRun.html_url
    if (iosBuild.conclusion !== "success") ios.error = `iOS ${iosBuild.conclusion}; downloads are not ready.`
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
      const coordinates = {pr: pr.number, sha, runId: iosRun.id, attempt: iosBuild.attempt}
      const receiptUrl = artifactUrl(
        `${repo.owner}/${repo.repo}`,
        "pr-builds",
        iosReceiptName(pr.number, sha, iosRun.id, iosBuild.attempt),
      )
      const receipt = await (await request(receiptUrl)).json()
      const assets = validateIosReceipt(receipt, coordinates)
      if (receipt.app?.backend !== backend) throw new Error(mismatch("iOS / macOS", receipt.app?.backend))
      const urls = {}
      let macHandoff = false
      for (const [kind, asset] of Object.entries(assets)) {
        urls[kind] = artifactUrl(`${repo.owner}/${repo.repo}`, "pr-builds", asset.name)
        const response = await request(urls[kind], iosTextTypes[kind] ? "GET" : "HEAD")
        if (iosTextTypes[kind]) {
          if (await verifyIosTextArtifact(response, kind, asset)) macHandoff = true
        } else if (Number(response.headers.get("content-length")) !== asset.size)
          throw new Error(`Published ${kind} download size disagrees with its receipt`)
      }
      ios.assets = urls
      ios.backend = backend
      ios.archiveSha256 = assets.mac.sha256
      if (macHandoff) ios.macInstallUrl = macInstallPageUrl(urls.install, receipt.runAttempt)
      ios.instructionsUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${receipt.buildSha}/mobile/ci/pr-ios/README.md`
    } catch (failure) {
      ios.error = failure.message
    }
  }
  const android = {}
  if (!error) {
    // The selected publication's receipt is the only evidence of the APK's backend.
    let receipt, archiveSha256
    try {
      const coordinates = {pr: pr.number, sha, runId: androidBuild.run.id, attempt: androidBuild.attempt}
      receipt = await (await request(artifactUrl(`${repo.owner}/${repo.repo}`, "pr-builds",
        androidReceiptName(pr.number, sha, coordinates.runId, coordinates.attempt)))).json()
      archiveSha256 = validateAndroidReceipt(receipt, coordinates).android.sha256
    } catch (failure) {
      receipt = undefined
      core.warning(`Android receipt unavailable: ${failure.message}; publish available downloads and keep receipt verification retryable.`)
      android.receiptUnavailable = true
    }
    if (receipt && receipt.app.backend !== backend) error = mismatch("Android", receipt.app.backend)
    else if (receipt) {
      android.backend = backend
      if (hasRoutineLabel(pr, "no-glasses-android")) android.archiveSha256 = archiveSha256
    }
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: pr.number,
    per_page: 100,
  })
  const comment = comments.find((item) => item.user?.type === "Bot" && item.body?.startsWith(marker))
  const incomplete = Boolean(error || ios.error)
  const publicationIdentity = builds
    .map((build) => `${build.run.id}-${build.attempt}`)
    .join(":")
  const buildIdentity = `${sha}:${incomplete ? "incomplete" : "ready"}:${publicationIdentity}`
  if (android.receiptUnavailable) {
    const previous = comment?.body.split("\n").map(line =>
      new RegExp(`^<!-- ${sha}:(?:incomplete|ready):${publicationIdentity}:android-([a-f0-9]{64}) -->$`).exec(line)).find(Boolean)
    if (previous) {
      // Reuse only the hash already verified for these exact publications. Readiness
      // can still advance so a newly available Apple download is not suppressed. The
      // identity does not record a destination, so the Android backend stays unverified.
      android.archiveSha256 = previous[1]
      android.receiptUnavailable = false
    }
  }
  const identity = `${buildIdentity}${android.receiptUnavailable ? ":android-receipt-unavailable" : android.archiveSha256 ? `:android-${android.archiveSha256}` : ""}`
  if (comment?.body.includes(`<!-- ${identity} -->`)) {
    core.info("This PR revision's notification was already delivered.")
    return
  }
  let routines = await requestedRoutineLinks({github, context, pr, sha, ios, android, core})
  if (!(await current())) {
    core.info("PR superseded or retargeted before notification.")
    return
  }
  routines = routines.filter(routine => hasRoutineLabel(pr, routine.id))
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
    routines,
    backend: android.backend ?? ios.backend,
    unverifiedBackend: !error && !android.backend ? ["Android"] : [],
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
      `${ios.assets.install ? `[Install on iPhone](${ios.assets.install}) · ` : ""}[Download iPhone IPA](${
        ios.assets.iphone
      }) · ${ios.macInstallUrl ? `[Install on Mac](${ios.macInstallUrl}) · ` : ""}[Download Mac app](${
        ios.assets.mac
      }) · [Installation instructions](${ios.instructionsUrl})`,
    )
  else downloads.push(ios.error || "iPhone / Mac: not built for these changed paths.")
  for (const routine of routines)
    downloads.push(
      `**Requested tests:** ${deviceRoutine(routine.id).name} · ${deviceRoutine(routine.id).platform === "android" ? "Android" : "iOS on Mac"}\n\n${[
        ...(routine.resultsUrl ? [`[View results](${routine.resultsUrl})`] : []),
        ...(routine.resultsUnavailable ? [routine.resultsUnavailable] : []),
        `[${routine.pipelineLabel}](${routine.pipelineUrl})`,
      ].join(" · ")}\n\nResults appear after the device run is uploaded.`,
    )
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
