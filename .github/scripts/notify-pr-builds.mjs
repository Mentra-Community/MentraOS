import {androidReceiptName, validateAndroidReceipt} from "./pr-android-artifacts.mjs"
import {MOBILE_PR_PATHS, prBackend} from "./pr-mobile-build.mjs"
import {createHash} from "node:crypto"
import {iosInstallUrl, macInstallPageUrl} from "./pr-ios-artifacts-install.mjs"
import {iosReceiptName, validateIosReceipt} from "./pr-ios-artifacts.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"
import {buildPost, otaTargets, postToWebhook, slackText} from "./slack-build-post.mjs"

// The Mentra monorepo holds this tree at public/mentraos, the ASG client at
// mentra_live/asg_client and the miniapps the app bundles at miniapps/; its
// producer workflows sit at the root's .github/workflows/.
export const MONOREPO = "Mentra-Community/Mentra"
const MONOREPO_ROOT = "public/mentraos/"

/** A changed file's path in MentraOS's layout; null when it has none (a bundled miniapp). */
export function mentraOsPath(filename, repository) {
  if (repository !== MONOREPO) return filename
  if (filename.startsWith(MONOREPO_ROOT)) return filename.slice(MONOREPO_ROOT.length)
  if (filename.startsWith("mentra_live/asg_client/")) return filename.slice("mentra_live/".length)
  if (filename.startsWith("miniapps/")) return null
  return filename
}

/**
 * Monorepo paths that start the PR app builds beyond MentraOS's own (the paths of its root mentra-app-*-build.yml and
 * mentra-asg-client-build.yml workflows): its glasses firmware and build scripts, and the SDK packages the bundled
 * miniapps are built with.
 */
export const MONOREPO_PR_BUILD_PATHS = [
  "public/mentraos/cloud-v2/tsconfig.base.json",
  "public/mentraos/cloud-v2/packages/auth/*",
  "public/mentraos/cloud-v2/packages/miniapp-tools/*",
  "public/mentraos/cloud-v2/packages/protocol/*",
  "public/mentraos/sdk/miniapp-cli/*",
  "mentra_live/bes/*",
  "testing/*",
  ".github/workflows/bes.yml",
  ".github/workflows/mentra-app-android-build.yml",
  ".github/workflows/mentra-app-ios-build.yml",
  ".github/workflows/mentra-asg-client-build.yml",
  ".github/workflows/reusable-pr-build-notification.yml",
  ".github/ci/pack-miniapps.sh",
  ".github/ci/bundled-miniapps.sh",
  ".github/ci/asg-build-identity.mjs",
]

const matches = (path, pattern) =>
  pattern.endsWith("*") ? path.startsWith(pattern.replace(/\*+$/, "")) : path === pattern

export function iosBuildRequired(files, repository) {
  return files.some(({filename}) => {
    if (repository === MONOREPO && MONOREPO_PR_BUILD_PATHS.some((pattern) => matches(filename, pattern))) return true
    const path = mentraOsPath(filename, repository)
    // The monorepo packs every miniapp into the app it builds.
    if (path === null) return true
    return MOBILE_PR_PATHS.some((pattern) => matches(path, pattern))
  })
}

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
  const targets = otaTargets(manifest, manifest.releaseVersion)
  const {asg} = targets
  if (!/^[a-f0-9]{64}$/i.test(asg.sha256 ?? "") || !Number.isSafeInteger(asg.apkSize) || asg.apkSize <= 0 ||
    !/^https:\/\//.test(asg.apkUrl ?? ""))
    throw new Error("OTA manifest is missing ASG, BES or MTK target metadata")
  return targets
}

const backendName = (backend) => (backend === "staging" ? "Staging" : "Dev")

/** The miniapps whose backend this PR changes: a PR build runs against the deployed ones. */
export function changedMiniappBackends(files) {
  const names = files.flatMap((file) => file.filename.match(/^miniapps\/(?:public\/)?([^/]+)\/backend\//)?.[1] ?? [])
  return [...new Set(names)].sort()
}

/** The small line under the title: `backend` is named only when a published receipt verified it for this PR's destination. */
function backendFact(backend, unverified) {
  if (!backend) return "backend not verified"
  return `${backendName(backend)} backend${unverified.length ? ` (${unverified.join(", ")} not verified)` : ""}`
}

/** The Mentra App's installs: HTTPS pages, which open the iPhone and Mac installers. */
function mentraInstalls({androidUrl, error, ios}) {
  return [
    ...(error ? [] : [{platform: "Android", url: androidUrl}]),
    ...(ios?.assets
      ? [
          {platform: "iPhone", url: ios.assets.install ?? ios.assets.iphone},
          {platform: "Mac", url: ios.macInstallUrl ?? ios.assets.mac},
        ]
      : []),
  ]
}

/** The #pr-builds post. `details` is the PR comment, which lists everything the post leaves out. */
export function prBuildPost({pr, sha, androidUrl, targets, androidRunUrl, error, errorRunUrl, ios, backend,
  unverifiedBackend = [], example, details = pr.html_url}) {
  const ready = !error && !ios?.error && !example?.error
  const title = ready ? "✅ PR build ready to test" : "⚠️ PR build incomplete"
  return buildPost({
    text: `${title}: #${pr.number} ${slackText(pr.title, 200)} (${sha.slice(0, 7)})`,
    title: `*${ready ? `✅ PR #${pr.number} ready to test` : `⚠️ PR #${pr.number} build incomplete`}:* ${slackText(pr.title, 150)}`,
    details,
    facts: [
      `${pr.head.ref} → ${pr.base.ref}`,
      `by ${pr.user.login}`,
      sha.slice(0, 7),
      ...(!error || ios?.assets ? [backendFact(backend, unverifiedBackend)] : []),
    ],
    apps: [
      {name: "Mentra App", installs: mentraInstalls({androidUrl, error, ios})},
      // The Bluetooth example, right after the Mentra App, when this PR built it.
      ...(example ? [{name: "Bluetooth example", installs: [
        {platform: "Android", url: example.androidUrl},
        {platform: "iPhone", url: example.iphoneUrl},
        {platform: "Mac", url: example.macUrl},
      ]}] : []),
    ],
    glasses: !error && targets ? {asg: targets.asg, bes: targets.bes, mtk: targets.mtk} : undefined,
    problems: [
      ...(error ? [{text: `*Android:* ${slackText(error, 200)}`, url: errorRunUrl ?? androidRunUrl}] : []),
      ...(ios?.error ? [{text: `*iPhone / Mac:* ${slackText(ios.error, 200)}`, url: ios.runUrl}] : []),
      ...(example?.error ? [{text: `*Bluetooth example:* ${slackText(example.error, 200)}`, url: example.runUrl}] : []),
    ],
  })
}

/** The PR comment: the post's details page, with every download, the glasses' OTA files and the logs. */
export function prBuildComment({identity, sha, androidUrl, manifestUrl, targets, androidRunUrl, asgRunUrl, error, ios,
  backend, example, changedBackends = []}) {
  const incomplete = Boolean(error || ios.error || example?.error)
  const links = (items) => items.map(([label, url]) => `[${label}](${url})`).join(" · ")
  const lines = [
    `**Mentra App:** ${error || links([["Download Android APK", androidUrl]])}`,
    ios.assets
      ? `**iPhone / Mac:** ${links([
          ...(ios.assets.install ? [["Install on iPhone", ios.assets.install]] : []),
          ["Download iPhone IPA", ios.assets.iphone],
          ...(ios.macInstallUrl ? [["Install on Mac", ios.macInstallUrl]] : []),
          [ios.macInstallUrl ? "Download Mac app (first-time setup)" : "Download Mac app", ios.assets.mac],
        ])}`
      : `**iPhone / Mac:** ${ios.error || "not built for these changed paths."}`,
    ...(example ? [`**Bluetooth example:** ${example.error || links([
      ...(example.androidUrl ? [["Download Android APK", example.androidUrl]] : []),
      ...(example.iphoneUrl ? [["Install on iPhone", example.iphoneUrl]] : []),
      ...(example.macUrl ? [["Install on Mac", example.macUrl]] : []),
    ])}`] : []),
    ...(!error && targets
      ? [`**Glasses:** ASG ${targets.asg.versionName} (build ${targets.asg.versionCode}) · BES ${targets.bes} · MTK ${targets.mtk} · ${links([
          ["Glasses OTA manifest", manifestUrl], ["ASG APK", targets.asg.apkUrl]])}`]
      : []),
    `**Setup:** ${[
      backend ? `${backendName(backend)} backend` : "backend not verified",
      "Android ARM64",
      ...(ios.assets ? ["Apple devices must be registered", links([["Installation instructions", ios.instructionsUrl]])] : []),
    ].join(" · ")}`,
    `**Logs:** ${links([["Android build logs", androidRunUrl], ...(ios.runUrl ? [["iOS build logs", ios.runUrl]] : []),
      ...(asgRunUrl ? [["ASG build logs", asgRunUrl]] : [])])}`,
  ]
  return `${marker}\n<!-- ${identity} -->\n${
    incomplete ? "⚠️ PR build incomplete" : "✅ PR build ready to test"
  } for \`${sha.slice(0, 7)}\` — posted to **#pr-builds**.\n\n${lines.join("\n\n")}${
    changedBackends.length
      ? `\n\n⚠️ This PR changes the backend of ${changedBackends.join(", ")}, and this build doesn't include that: it runs against the deployed backend until the PR is merged.`
      : ""
  }${incomplete ? "" : "\n\nDownloads may be cleaned up after 7 days."}`
}

// The run name of a label change that requests no build: never the build.
export const NO_BUILD_RUN_NAME = "No build: label change"

export function matchingBuildRun(runs, pr, sha) {
  return runs
    .filter(
      (run) =>
        run.event === "pull_request" &&
        run.display_title !== NO_BUILD_RUN_NAME &&
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
  const changedBackends = changedMiniappBackends(files)
  const ios = {required: iosBuildRequired(files, `${repo.owner}/${repo.repo}`)}
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
  // The APK this publication's receipt names when it built one, linked only while that receipt is unavailable.
  let androidUrl = `${base}/${androidReceiptName(pr.number, sha, androidBuild.run.id, androidBuild.attempt).replace(/\.json$/, ".apk")}`
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
      // The installation page opens the receipt it was published with: an earlier head's when reused.
      if (macHandoff) ios.macInstallUrl = macInstallPageUrl(urls.install, receipt.reusedFrom?.runAttempt ?? receipt.runAttempt)
      const tree = `${repo.owner}/${repo.repo}` === MONOREPO ? MONOREPO_ROOT : ""
      ios.instructionsUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${receipt.buildSha}/${tree}mobile/ci/pr-ios/README.md`
    } catch (failure) {
      ios.error = failure.message
    }
  }
  const android = {}
  if (!error) {
    // The selected publication's receipt is the only evidence of the APK's backend.
    let receipt, asset
    try {
      const coordinates = {pr: pr.number, sha, runId: androidBuild.run.id, attempt: androidBuild.attempt}
      receipt = await (await request(artifactUrl(`${repo.owner}/${repo.repo}`, "pr-builds",
        androidReceiptName(pr.number, sha, coordinates.runId, coordinates.attempt)))).json()
      // The monorepo's APKs pin its own OTA manifests; MentraOS's pin MentraOS's.
      const repository = `${repo.owner}/${repo.repo}` === MONOREPO ? MONOREPO : undefined
      asset = validateAndroidReceipt(receipt, {...coordinates, repository}).android
    } catch (failure) {
      receipt = undefined
      core.warning(`Android receipt unavailable: ${failure.message}; publish available downloads and keep receipt verification retryable.`)
      android.receiptUnavailable = true
    }
    try {
      if (!receipt) await request(androidUrl, "HEAD")
      else if (receipt.app.backend !== backend) error = mismatch("Android", receipt.app.backend)
      else {
        // Link the exact receipt-bound APK.
        const url = artifactUrl(`${repo.owner}/${repo.repo}`, "pr-builds", asset.name)
        if (Number((await request(url, "HEAD")).headers.get("content-length")) !== asset.size)
          throw new Error("Published Android APK size disagrees with its receipt")
        androidUrl = url
        android.backend = backend
        android.archiveSha256 = asset.sha256
      }
    } catch (failure) {
      error = failure.message
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
      new RegExp(`^<!-- ${buildIdentity}:android-([a-f0-9]{64}) -->$`).exec(line)).find(Boolean)
    if (previous) {
      // A transient receipt miss must not downgrade a post already verified for this exact
      // build identity, readiness included, so this matches it and nothing is reposted. When
      // readiness changed, the new post stays receipt-unavailable so a later verified receipt
      // enriches it once instead of being suppressed by a reused verified identity.
      android.archiveSha256 = previous[1]
      android.receiptUnavailable = false
    }
  }
  // A verified APK binds its immutable hash; an unverified backend is distinct so a
  // later notification can replace it once its receipt verifies.
  const identity = `${buildIdentity}${android.receiptUnavailable ? ":android-receipt-unavailable" : android.archiveSha256 ? `:android-${android.archiveSha256}` : ""}`
  if (comment?.body.includes(`<!-- ${identity} -->`)) {
    core.info("This PR revision's notification was already delivered.")
    return
  }
  if (!(await current())) {
    core.info("PR superseded or retargeted before notification.")
    return
  }
  const post = {
    sha,
    androidUrl,
    manifestUrl,
    targets,
    androidRunUrl,
    asgRunUrl: asgRun?.html_url,
    error,
    ios,
    backend: android.backend ?? ios.backend,
  }
  await postToWebhook(webhook, prBuildPost({
    ...post,
    pr,
    errorRunUrl: androidBuild.conclusion === "success" && asgBuild.conclusion !== "success" ? asgRun.html_url : androidRunUrl,
    unverifiedBackend: !error && !android.backend ? ["Android"] : [],
    details: comment?.html_url,
  }), fetchImpl)
  const body = prBuildComment({...post, identity, changedBackends})
  if (comment) await github.rest.issues.updateComment({...repo, comment_id: comment.id, body})
  else await github.rest.issues.createComment({...repo, issue_number: pr.number, body})
  core.info(`Delivered ${identity} to #pr-builds`)
  if (error) core.warning(error)
  if (ios.error) core.warning(ios.error)
}
