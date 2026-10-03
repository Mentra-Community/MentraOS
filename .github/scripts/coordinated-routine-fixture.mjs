import {createHash} from "node:crypto"
import {downloadNames} from "./coordinated-install-downloads.mjs"
import {COORDINATED_FINALIZE_JOB, COORDINATED_PUBLISH_STEP} from "./coordinated-routine-request.mjs"

/** Synthetic metadata fixture. No application archive or credential is included. */
export function coordinatedFixture(channel = "dev") {
  const repository = "Mentra-Community/MentraOS", head = "a".repeat(40), issuer = "b".repeat(40)
  const release = `3.3.0-${channel === "dev" ? "dev" : "beta"}.223`
  const plan = {schemaVersion: 1, releaseIdentity: release, releaseSetId: `mentra-${release}`,
    sourceCommit: head, channel: channel === "dev" ? "dev" : "beta", artifactContainerTag: "mentra-builds-v3.3.0",
    native: {marketingVersion: "3.3.0", buildNumber: 303000223}, artifactNames: {otaManifest: `mentra-live-ota-${release}.json`}}
  const prefix = `https://artifactscdn.mentraglass.com/${repository}/releases/${plan.artifactContainerTag}/`
  const names = downloadNames(plan)
  const receipt = {schemaVersion: 1, releaseIdentity: release, sourceCommit: head,
    app: {bundleId: "com.mentra.mentra", app: "Mentra.app", headSha: head, buildSha: head, releaseIdentity: release,
      backend: channel, otaManifestUrl: prefix + plan.artifactNames.otaManifest, version: "3.3.0", build: "303000223",
      executableSha256: "c".repeat(64), javascriptSha256: "d".repeat(64), profileUUID: "12345678-1234-4234-8234-123456789abc",
      launcherPath: "launch-ios-on-mac", launcherSha256: "1".repeat(64),
      profileExpires: "2030-01-01T00:00:00", teamId: "T5XXXL6N36"},
    artifacts: Object.fromEntries(["iphone", "mac", "manifest", "install"].map(kind =>
      [kind, {name: names[kind], sha256: "e".repeat(64), size: 1234}]))}
  const ota = {releaseVersion: release, apps: {"com.mentra.asg_client": {versionName: "3.3.0", versionCode: 303000223,
    sha256: "f".repeat(64), apkSize: 456, apkUrl: prefix + "asg.apk"}},
    bes_firmware: {version: "26.9.23.4"}, mtk_full_ota: {end_firmware: "MentraLive_20260921.0"}}
  const run = {id: 100, run_attempt: 2, head_sha: head, head_branch: channel, status: "completed", conclusion: "success",
    path: ".github/workflows/coordinated-release.yml", event: "push", repository: {full_name: repository},
    head_repository: {full_name: repository}, created_at: "2026-09-23T00:00:00Z"}
  const artifact = {id: 200, name: `coordinated-release-plan-mentra-${release}`, expired: false,
    workflow_run: {id: run.id, head_sha: head}}
  const jobs = [{id: 1001, name: COORDINATED_FINALIZE_JOB, run_attempt: 2, status: "completed", conclusion: "success",
    steps: [{name: COORDINATED_PUBLISH_STEP, status: "completed", conclusion: "success"}]}]
  const state = {plan, receipt, ota, run, artifacts: [artifact], jobs, jobsResponse: null,
    ancestry: "ahead", devSha: issuer, reads: 0, changed: false, calls: []}
  const github = {rest: {actions: {
    getWorkflowRunAttempt: async input => { state.calls.push(input); state.reads++; return {data: {...state.run,
      ...(state.changed && state.reads > 1 ? {head_sha: "f".repeat(40)} : {})}} },
    listWorkflowRunArtifacts: () => {},
    listJobsForWorkflowRun: async input => { state.calls.push({jobs: input});
      return {data: state.jobsResponse ?? {total_count: state.jobs.length, jobs: state.jobs}} },
  }, git: {getRef: async ({ref}) => ({data: {ref: `refs/${ref}`, object: {type: "commit", sha: ref === "heads/dev" ? state.devSha : issuer}}})},
  repos: {compareCommitsWithBasehead: async ({basehead}) => {
    state.calls.push({compare: basehead})
    const [base, tip] = basehead.split("...")
    return {data: {status: base === issuer ? (base === tip ? "identical" : "ahead") : state.ancestry,
      base_commit: {sha: base}, merge_base_commit: {sha: base}}}
  }}},
  paginate: async () => state.artifacts}
  const fetchImpl = async (url, options) => {
    state.calls.push({url, method: options?.method})
    if (url === prefix + names.mac && options?.method === "HEAD")
      return new Response(null, {headers: {"content-length": "1234"}})
    const payload = new Map([[prefix + `mentra-release-plan-${release}.json`, state.plan],
      [prefix + names.receipt, state.receipt], [prefix + plan.artifactNames.otaManifest, state.ota]]).get(url)
    return payload ? new Response(JSON.stringify(payload)) : new Response("missing", {status: 404})
  }
  const options = {github, context: {repo: {owner: "Mentra-Community", repo: "MentraOS"}, runId: 500, eventName: "workflow_dispatch"},
    channel, routine: "no-glasses", sourceBuildRunId: "100", sourcePublicationAttempt: "2", fetchImpl,
    now: () => new Date("2026-09-23T01:00:00Z"), source: {runAttempt: 1, ref: "refs/heads/dev", sha: issuer, workflowSha: issuer,
      workflowRef: `${repository}/.github/workflows/request-e2e-routine.yml@refs/heads/dev`, actor: "synthetic-operator"}}
  return {state, options, pin: value => createHash("sha256").update(JSON.stringify(value)).digest("hex")}
}
