import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {TestBuildPlatform, TestBuild, TestBuildQuery, TestBuildSource} from "../types/test-build.types";
import { TestRunGithubApp } from "./test-run-github-app";

const REPOSITORY = "Mentra-Community/MentraOS";
const prWorkflow = (platform: TestBuildPlatform) => platform === "android" ? "mentra-app-android-build.yml" : "mentra-app-ios-build.yml";
const RELEASE_WORKFLOW = "coordinated-release.yml";
const RELEASE_FINALIZE_JOB = "Finalize immutable release bill of materials";
const RELEASE_PUBLISH_STEP = "Publish immutable plan, package, and manifest assets";
const CDN = `https://artifactscdn.mentraglass.com/${REPOSITORY}/releases/`;
// Google Play's largest accepted version code.
const ANDROID_MAX_VERSION_CODE = 2_100_000_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const repositorySchema = z.object({ full_name: z.string() });
const runSchema = z.object({
  id: positive, run_attempt: positive, head_sha: sha, head_branch: z.string(), path: z.string(),
  event: z.string(), status: z.string(), conclusion: z.string().nullable(), created_at: z.string(),
  display_title: z.string(), repository: repositorySchema, head_repository: repositorySchema,
});
type GithubRun = z.infer<typeof runSchema>;
const assetSchema = z.object({ name: z.string(), sha256: digest, size: positive });
const jobSchema = z.object({ id: positive, name: z.string(), run_attempt: positive, status: z.string(),
  conclusion: z.string().nullable(), started_at: z.string().nullable(), completed_at: z.string().nullable(),
  steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })).optional() });
type Job = z.infer<typeof jobSchema>;
// PR destinations whose exact PR-head artifacts are built against their own backend.
const PR_BASES = ["dev", "staging"] as const;
type PrBase = typeof PR_BASES[number];
const prSchema = z.object({ number: positive, state: z.string(), title: z.string(),
  head: z.object({ sha, ref: z.string(), repo: repositorySchema }), base: z.object({ ref: z.string() }) });
type PullRequest = z.infer<typeof prSchema>;
/** The PR a build must belong to: the current PR, or an authenticated original request's recorded PR. */
type PrIdentity = { number: number; title: string; head: { sha: string }; base: { ref: string } };
export class TestDispatchError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 501 | 502 | 503, message: string) { super(message); }
}
/**
 * An authenticated source whose exact original build has no immutable published artifact or
 * dispatch path (for example a local run). A capability limit, not an invalid or untrusted source:
 * investigation, fix PRs and candidate CI verification remain available.
 */
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new TestDispatchError(409, message);
}
const runUrl = (repository: string, id: number) => `https://github.com/${repository}/actions/runs/${id}`;

/** Bounded metadata reads only. No artifact application code is loaded or run. */
export async function readTestMetadata(response: Response, maxBytes = 1024 * 1024): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new TestDispatchError(502, `Build metadata unavailable (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new TestDispatchError(502, "Build metadata exceeds its size limit");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TestDispatchError(502, "Invalid build metadata JSON"); }
}

function publication(run: GithubRun, jobs: Job[]) {
  const latest = (name: string) => jobs.filter(job => job.name === name && job.run_attempt <= run.run_attempt)
    .sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)[0];
  const build = latest("build"), publish = latest("publish");
  if (!build || !publish || [build, publish].some(job => job.status !== "completed" || job.conclusion !== "success")
    || build.run_attempt > publish.run_attempt) return null;
  const first = (job: Job) => Math.min(job.run_attempt, ...jobs.filter(item => item.name === job.name
    && item.started_at === job.started_at && item.completed_at === job.completed_at && item.conclusion === job.conclusion)
    .map(item => item.run_attempt));
  return { build: first(build), publish: first(publish) };
}

export interface TestBuildGateway {
  inventory(query: TestBuildQuery): Promise<TestBuild[]>;
  resolve(source: TestBuildSource, platform: TestBuildPlatform): Promise<TestBuild>;
}

export class GithubTestBuildGateway implements TestBuildGateway {
  constructor(private readonly options: {
    token?: string; privateReadToken?: string; appAuth?: TestRunGithubApp; fetch?: typeof fetch; channels?: string[]; routines?: string[];
  } = {}) { this.appAuth = options.appAuth ?? new TestRunGithubApp({ fetch: options.fetch }); }
  private readonly appAuth: TestRunGithubApp;
  private fetcher = (input: string, init: RequestInit = {}) => (this.options.fetch ?? fetch)(input,
    { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
  private async token(scope: "source" | "private" = "source") {
    const injected = scope === "source" ? this.options.token : this.options.privateReadToken;
    if (injected) return injected;
    try { return await this.appAuth.token(scope); }
    catch { throw new TestDispatchError(503, "Routine GitHub App authentication is unavailable; check the Core GitHub App configuration"); }
  }
  private async api(path: string, init: RequestInit = {}, token?: string) {
    const credential = token ?? await this.token();
    const response = await this.fetcher(`https://api.github.com/repos/${path}`, {
      ...init, headers: { Authorization: `Bearer ${credential}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (response.status === 404) throw new TestDispatchError(404, "Selected GitHub build was not found");
    return parseJson(await readTestMetadata(response, 4 * 1024 * 1024));
  }
  private async metadata(tag: string, name: string) {
    // Both segments are constructed from validated identities, never supplied URLs.
    requireThat(/^[A-Za-z0-9._-]+$/.test(tag) && /^[A-Za-z0-9._-]+$/.test(name), "Invalid artifact identity");
    const url = `${CDN}${tag}/${name}`;
    const bytes = await readTestMetadata(await this.fetcher(url));
    return { value: parseJson(bytes), sha256: hash(bytes), url, size: bytes.byteLength };
  }
  private async jobs(runId: number): Promise<Job[]> {
    const jobs: Job[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(jobSchema) }).parse(
        await this.api(`${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`));
      jobs.push(...data.jobs);
      if (jobs.length === data.total_count) return jobs;
      requireThat(jobs.length < data.total_count && data.jobs.length === 100, "Incomplete build job history");
    }
    throw new TestDispatchError(502, "Build job history exceeds its limit");
  }
  private async pr(number: number) {
    const pr = prSchema.parse(await this.api(`${REPOSITORY}/pulls/${number}`));
    requireThat(pr.number === number && pr.state === "open" && (PR_BASES as readonly string[]).includes(pr.base.ref)
      && pr.head.repo.full_name === REPOSITORY, "Choose an open same-repository PR targeting dev or staging");
    return pr;
  }
  /** The actual tip of the PR's admitted base; the PR API's base SHA can lag it. */
  private async baseSha(pr: PullRequest) {
    const base = pr.base.ref as PrBase;
    const ref = z.object({ ref: z.literal(`refs/heads/${base}`), object: z.object({ type: z.literal("commit"), sha }) })
      .parse(await this.api(`${REPOSITORY}/git/ref/heads/${base}`));
    return ref.object.sha;
  }
  async inventory(query: TestBuildQuery): Promise<TestBuild[]> {
    const pr = query.channel === "pr" ? await this.pr(query.pr!) : undefined;
    const platform = query.platform;
    const workflow = pr ? prWorkflow(platform) : RELEASE_WORKFLOW;
    const filter = pr ? `event=pull_request&head_sha=${pr.head.sha}` : `branch=${query.channel}`;
    const data = z.object({ workflow_runs: z.array(runSchema) }).parse(
      await this.api(`${REPOSITORY}/actions/workflows/${workflow}/runs?${filter}&per_page=10`));
    const base = pr ? await this.baseSha(pr) : undefined;
    return Promise.all(data.workflow_runs.filter(run => this.matches(run, query.channel, platform, pr)).map(run =>
      this.describe(run, query.channel, platform, pr, base)));
  }
  /** Latest immutable dev publication at the occurrence boundary. Incomplete history never selects an older build. */
  async latestDev(platform: TestBuildPlatform, before: string): Promise<TestBuild | null> {
    const boundary = Date.parse(before);
    if (!Number.isFinite(boundary)) throw new TestDispatchError(400, "Invalid nightly build boundary");
    const seen = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const data = z.object({total_count: z.number().int().nonnegative(), workflow_runs: z.array(runSchema)}).parse(
        await this.api(`${REPOSITORY}/actions/workflows/${RELEASE_WORKFLOW}/runs?branch=dev&created=<=${encodeURIComponent(before)}&per_page=100&page=${page}`));
      for (const run of data.workflow_runs) {
        if (seen.has(run.id)) throw new TestDispatchError(502, "Nightly build history changed while reading");
        seen.add(run.id);
      }
      const candidates = data.workflow_runs.filter(run => this.matches(run, "dev", platform)
        && Date.parse(run.created_at) <= boundary).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
      for (const run of candidates) {
        // Later reruns cannot supersede the publication that existed when this occurrence began.
        const finalizers = (await this.jobs(run.id)).filter(job => job.name === RELEASE_FINALIZE_JOB && job.run_attempt <= run.run_attempt
          && job.started_at && Number.isFinite(Date.parse(job.started_at)) && Date.parse(job.started_at) <= boundary);
        const latest = Math.max(0, ...finalizers.map(job => job.run_attempt));
        const current = finalizers.filter(job => job.run_attempt === latest);
        if (current.length > 1) throw new TestDispatchError(502, "Nightly publication is ambiguous");
        if (current[0]?.status !== "completed" || current[0]?.conclusion !== "success"
          || !current[0]?.steps?.some(step => step.name === RELEASE_PUBLISH_STEP && step.status === "completed" && step.conclusion === "success")
          || !current[0]?.completed_at || !Number.isFinite(Date.parse(current[0].completed_at))
          || Date.parse(current[0].completed_at) > boundary) continue;
        // A published but missing platform artifact remains unavailable; do not silently use an older release.
        const publicationAttempt = Math.min(latest, ...finalizers.filter(job => job.started_at && job.completed_at
          && job.started_at === current[0]!.started_at && job.completed_at === current[0]!.completed_at
          && job.conclusion === current[0]!.conclusion).map(job => job.run_attempt));
        return this.describe({...run, run_attempt: publicationAttempt}, "dev", platform, undefined, undefined, true);
      }
      if (seen.size === data.total_count) return null;
      if (seen.size > data.total_count || data.workflow_runs.length !== 100)
        throw new TestDispatchError(502, "Nightly build history is incomplete");
    }
    throw new TestDispatchError(502, "Nightly build history exceeds its limit");
  }
  private matches(run: GithubRun, channel: TestBuildSource["channel"], platform: TestBuildPlatform, pr?: PullRequest) {
    return run.repository.full_name === REPOSITORY && run.head_repository.full_name === REPOSITORY
      && run.path === `.github/workflows/${pr ? prWorkflow(platform) : RELEASE_WORKFLOW}`
      && (pr ? run.event === "pull_request" && run.head_sha === pr.head.sha && run.head_branch === pr.head.ref
        : ["push", "workflow_dispatch"].includes(run.event) && run.head_branch === channel);
  }
  async resolve(source: TestBuildSource, platform: TestBuildPlatform): Promise<TestBuild> {
    const pr = source.channel === "pr" ? await this.pr(source.prNumber) : undefined;
    const run = runSchema.parse(await this.api(`${REPOSITORY}/actions/runs/${source.buildRunId}/attempts/${source.publicationAttempt}`));
    requireThat(run.id === source.buildRunId && run.run_attempt === source.publicationAttempt && this.matches(run, source.channel, platform, pr),
      "Build does not match the selected source and publication attempt");
    const result = await this.describe(run, source.channel, platform, pr, pr ? await this.baseSha(pr) : undefined, true);
    requireThat(result.source.publicationAttempt === source.publicationAttempt, "Selected attempt retained a different publication");
    return result;
  }
  private async describe(run: GithubRun, channel: TestBuildSource["channel"], platform: TestBuildPlatform, pr?: PrIdentity, baseSha?: string, exact = false): Promise<TestBuild> {
    const source: TestBuildSource = pr ? { channel: "pr", prNumber: pr.number, buildRunId: run.id, publicationAttempt: run.run_attempt }
      : { channel: channel as "dev" | "staging", buildRunId: run.id, publicationAttempt: run.run_attempt };
    const build: TestBuild = { source, platform, title: pr ? `PR #${pr.number} — ${pr.title}` : run.display_title,
      headSha: run.head_sha, buildUrl: runUrl(REPOSITORY, run.id), createdAt: run.created_at,
      availability: "unavailable" };
    try {
      const artifacts = pr ? await (platform === "android" ? this.androidPrArtifacts(run, pr, baseSha!) : this.prArtifacts(run, pr, baseSha!))
        : await this.releaseArtifacts(run, channel, platform);
      build.source.publicationAttempt = artifacts.attempt;
      const archive = artifacts.archive;
      const response = await this.fetcher(`${CDN}${artifacts.tag}/${archive.name}`, { method: "HEAD" });
      if (!response.ok && response.status !== 404)
        throw new TestDispatchError(502, `Published app archive is temporarily unavailable (HTTP ${response.status})`);
      requireThat(response.ok && Number(response.headers.get("content-length")) === archive.size,
        "Published app archive is missing or its size differs from the receipt");
      return { ...build, ...artifacts.result, archive: {...archive, url: `${CDN}${artifacts.tag}/${archive.name}`}, availability: "available" };
    } catch (error) {
      // Inventory can describe an unavailable row, but dispatch must not make a
      // permanent rejection from a transient provider or network failure.
      if (exact && (!(error instanceof TestDispatchError) || error.status >= 500)) throw error;
      return { ...build, reason: error instanceof TestDispatchError ? error.message : "Published metadata does not match this build" };
    }
  }
  private async prArtifacts(run: GithubRun, pr: PrIdentity, baseSha: string) {
    const attempts = publication(run, await this.jobs(run.id));
    requireThat(attempts, "Build or Mac publication has not succeeded");
    const suffix = `pr-${pr.number}-${pr.head.sha}-${run.id}-${attempts.publish}`;
    const receipt = await this.metadata("pr-builds", `mentra-ios-${suffix}.json`);
    const data = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), pr: positive, headSha: sha,
      runId: positive, runAttempt: positive, buildAttempt: positive.optional(), buildSha: sha,
      app: z.object({ bundleId: z.literal("com.mentra.mentra"), teamId: z.literal("T5XXXL6N36"), backend: z.enum(PR_BASES),
        headSha: sha, buildSha: sha, runId: positive, runAttempt: positive, otaManifestUrl: z.string(),
        executableSha256: digest, javascriptSha256: digest }), artifacts: z.object({ mac: assetSchema }) }).parse(receipt.value);
    const otaName = `ota-pr-${pr.number}-${pr.head.sha}.json`;
    requireThat(data.pr === pr.number && data.headSha === pr.head.sha && data.runId === run.id && data.runAttempt === attempts.publish
      && (data.buildAttempt ?? data.runAttempt) === attempts.build && data.app.headSha === data.headSha
      && data.app.buildSha === data.buildSha && data.app.runId === run.id && data.app.runAttempt === attempts.build
      && data.app.backend === pr.base.ref && data.app.otaManifestUrl === `${CDN}pr-builds/${otaName}`
      && data.artifacts.mac.name === `mentra-ios-mac-pr-${pr.number}-${pr.head.sha}-${run.id}-${attempts.build}.zip`,
      "Mac receipt belongs to a different PR build");
    const commit = z.object({ sha, parents: z.array(z.object({ sha })) }).parse(await this.api(`${REPOSITORY}/commits/${data.buildSha}`));
    requireThat(commit.sha === data.buildSha && commit.parents.length === 2 && commit.parents[0]!.sha === baseSha
      && commit.parents[1]!.sha === pr.head.sha, "Mac build does not contain the current PR head and base");
    const ota = await this.metadata("pr-builds", otaName);
    requireThat(z.object({ releaseVersion: z.string() }).parse(ota.value).releaseVersion === `pr-${pr.number}-${pr.head.sha}`,
      "OTA manifest belongs to another PR revision");
    return { attempt: attempts.publish, tag: "pr-builds", archive: data.artifacts.mac,
      result: { receipt: {url: receipt.url, sha256: receipt.sha256, size: receipt.size}, manifestSha256: ota.sha256, manifest: {url: ota.url, sha256: ota.sha256, size: ota.size} } };
  }
  private async androidPrArtifacts(run: GithubRun, pr: PrIdentity, baseSha: string) {
    const jobs = await this.jobs(run.id);
    const builds = jobs.filter(job => job.name === "build" && job.run_attempt <= run.run_attempt);
    const latest = Math.max(0, ...builds.map(job => job.run_attempt));
    const candidates = builds.filter(job => job.run_attempt === latest);
    requireThat(candidates.length === 1 && candidates[0]!.status === "completed" && candidates[0]!.conclusion === "success"
      && candidates[0]!.steps?.some(step => step.name === "Upload APK to the public artifact CDN"
        && step.status === "completed" && step.conclusion === "success"), "Android APK publication has not succeeded");
    const build = candidates[0]!;
    const attempt = Math.min(latest, ...builds.filter(job => build.started_at && build.completed_at
      && job.started_at === build.started_at && job.completed_at === build.completed_at && job.conclusion === build.conclusion)
      .map(job => job.run_attempt));
    const name = `mentra-android-pr-${pr.number}-${pr.head.sha}-${run.id}-${attempt}`;
    const receipt = await this.metadata("pr-builds", `${name}.json`);
    const data = z.object({ schemaVersion: z.literal(1), pr: positive, headSha: sha, baseSha: sha, buildSha: sha,
      runId: positive, runAttempt: positive,
      app: z.object({ packageId: z.literal("com.mentra.mentra"), version: z.string().min(1), build: z.string().regex(/^[1-9]\d*$/),
        headSha: sha, buildSha: sha, backend: z.enum(PR_BASES), otaManifestUrl: z.string() }),
      artifacts: z.object({ android: assetSchema }) }).parse(receipt.value);
    const otaName = `ota-pr-${pr.number}-${pr.head.sha}.json`;
    requireThat(data.pr === pr.number && data.headSha === pr.head.sha && data.baseSha === baseSha
      && data.runId === run.id && data.runAttempt === attempt && data.app.headSha === data.headSha
      && data.app.buildSha === data.buildSha && data.app.backend === pr.base.ref && data.app.otaManifestUrl === `${CDN}pr-builds/${otaName}`
      && data.artifacts.android.name === `${name}.apk`, "Android receipt belongs to a different PR build");
    const commit = z.object({ sha, parents: z.array(z.object({ sha })) }).parse(await this.api(`${REPOSITORY}/commits/${data.buildSha}`));
    requireThat(commit.sha === data.buildSha && commit.parents.length === 2 && commit.parents[0]!.sha === baseSha
      && commit.parents[1]!.sha === pr.head.sha, "Android build does not contain the current PR head and base");
    const ota = await this.metadata("pr-builds", otaName);
    requireThat(z.object({ releaseVersion: z.string() }).parse(ota.value).releaseVersion === `pr-${pr.number}-${pr.head.sha}`,
      "OTA manifest belongs to another PR revision");
    return { attempt, tag: "pr-builds", archive: data.artifacts.android,
      result: { receipt: {url: receipt.url, sha256: receipt.sha256, size: receipt.size}, manifestSha256: ota.sha256, manifest: {url: ota.url, sha256: ota.sha256, size: ota.size} } };
  }
  private async releaseArtifacts(run: GithubRun, channel: TestBuildSource["channel"], platform: TestBuildPlatform) {
    // Downstream failures and notification-only retries do not erase a publication.
    // A newer finalizer execution must qualify itself; never fall back past it.
    const finalizers = (await this.jobs(run.id)).filter(job => job.name === RELEASE_FINALIZE_JOB && job.run_attempt <= run.run_attempt);
    const latestAttempt = Math.max(0, ...finalizers.map(job => job.run_attempt));
    const published = finalizers.filter(job => job.run_attempt === latestAttempt);
    requireThat(published.length === 1 && published[0]!.status === "completed" && published[0]!.conclusion === "success"
      && published[0]!.steps?.some(step => step.name === RELEASE_PUBLISH_STEP && step.status === "completed" && step.conclusion === "success"),
      "Selected coordinated attempt did not publish immutable assets");
    const job = published[0]!;
    // GitHub can repeat a retained successful job in a later attempt's history.
    const attempt = Math.min(job.run_attempt, ...finalizers.filter(item => job.started_at && job.completed_at
      && item.started_at === job.started_at && item.completed_at === job.completed_at && item.conclusion === job.conclusion)
      .map(item => item.run_attempt));
    const listed = z.object({ artifacts: z.array(z.object({ name: z.string(), expired: z.boolean(),
      workflow_run: z.object({ id: positive, head_sha: sha }) })) }).parse(await this.api(`${REPOSITORY}/actions/runs/${run.id}/artifacts?per_page=100`));
    const plans = listed.artifacts.filter(item => item.name.startsWith("coordinated-release-plan-mentra-"));
    requireThat(plans.length === 1 && !plans[0]!.expired && plans[0]!.workflow_run.id === run.id
      && plans[0]!.workflow_run.head_sha === run.head_sha, "Release plan is missing or ambiguous");
    const identity = plans[0]!.name.slice("coordinated-release-plan-mentra-".length);
    const match = /^(\d+\.\d+\.\d+)-(dev|beta)\.[1-9]\d*$/.exec(identity);
    requireThat(match && match[2] === (channel === "dev" ? "dev" : "beta"), "Release identity does not match the selected channel");
    const tag = `mentra-builds-v${match[1]}`;
    const planMetadata = await this.metadata(tag, `mentra-release-plan-${identity}.json`);
    const plan = z.object({ releaseIdentity: z.string(), sourceCommit: sha, channel: z.string(), artifactContainerTag: z.string(),
      native: z.object({ buildNumber: positive, marketingVersion: z.string() }), artifactNames: z.object({ otaManifest: z.string(), androidApp: z.string().optional(), releaseManifest: z.string().optional() }) })
      .parse(planMetadata.value);
    requireThat(plan.releaseIdentity === identity && plan.sourceCommit === run.head_sha && plan.channel === match[2]
      && plan.artifactContainerTag === tag && plan.artifactNames.otaManifest === `mentra-live-ota-${identity}.json`,
      "Published plan does not match the producing run");
    if (platform === "android") {
      requireThat(plan.artifactNames.androidApp === `mentraos-${identity}-android.apk`
        && plan.artifactNames.releaseManifest === `mentra-release-${identity}.json`, "Release plan has no matching Android APK");
      const receipt = await this.metadata(tag, plan.artifactNames.releaseManifest);
      const data = z.object({ schemaVersion: z.literal(1), releaseIdentity: z.string(), releaseSetId: z.string(), sourceCommit: sha,
        releasePlanSha256: digest, channel: z.string(),
        native: z.record(z.string(), z.unknown()),
        artifacts: z.array(z.object({ coordinate: z.string() }).passthrough()) }).parse(receipt.value);
      const assets = data.artifacts.filter(asset => asset.coordinate === plan.artifactNames.androidApp);
      // The manifest copies the plan's native identity and may add only the Android version code it built.
      const { androidBuildNumber: versionCode = plan.native.buildNumber, ...planNative } = data.native;
      requireThat(data.releaseIdentity === identity && data.releaseSetId === `mentra-${identity}`
        && data.sourceCommit === run.head_sha && data.channel === match[2] && data.releasePlanSha256 === planMetadata.sha256
        && isDeepStrictEqual(planNative, (planMetadata.value as { native?: unknown }).native)
        && typeof versionCode === "number" && Number.isSafeInteger(versionCode)
        && versionCode >= plan.native.buildNumber && versionCode <= ANDROID_MAX_VERSION_CODE
        && assets.length === 1 && assets[0]!.url === `${CDN}${tag}/${plan.artifactNames.androidApp}`
        && ["built", "published", "reused"].includes(String(assets[0]!.status)), "Android receipt does not match the selected coordinated release");
      const archive = assetSchema.parse({ name: assets[0]!.coordinate, sha256: assets[0]!.sha256, size: assets[0]!.size });
      const ota = await this.metadata(tag, plan.artifactNames.otaManifest);
      requireThat(z.object({ releaseVersion: z.string() }).parse(ota.value).releaseVersion === identity, "OTA manifest release differs");
      return { attempt, tag, archive, result: { release: identity, receipt: {url: receipt.url, sha256: receipt.sha256, size: receipt.size}, manifestSha256: ota.sha256, manifest: {url: ota.url, sha256: ota.sha256, size: ota.size} } };
    }
    const receipt = await this.metadata(tag, `mentraos-${identity}-apple-downloads.json`);
    const data = z.object({ schemaVersion: z.literal(1), releaseIdentity: z.string(), sourceCommit: sha,
      app: z.object({ bundleId: z.literal("com.mentra.mentra"), headSha: sha, backend: z.string(), build: z.string(),
        version: z.string(), otaManifestUrl: z.string(), executableSha256: digest, javascriptSha256: digest }),
      artifacts: z.object({ mac: assetSchema }) }).parse(receipt.value);
    requireThat(data.releaseIdentity === identity && data.sourceCommit === run.head_sha && data.app.headSha === run.head_sha
      && data.app.backend === channel && data.app.build === String(plan.native.buildNumber) && data.app.version === plan.native.marketingVersion
      && data.app.otaManifestUrl === `${CDN}${tag}/${plan.artifactNames.otaManifest}` && data.artifacts.mac.name === `mentraos-${identity}-mac.zip`,
      "Mac receipt does not match the selected coordinated release");
    const ota = await this.metadata(tag, plan.artifactNames.otaManifest);
    requireThat(z.object({ releaseVersion: z.string() }).parse(ota.value).releaseVersion === identity, "OTA manifest release differs");
    return { attempt, tag, archive: data.artifacts.mac,
      result: { release: identity, receipt: {url: receipt.url, sha256: receipt.sha256, size: receipt.size}, manifestSha256: ota.sha256, manifest: {url: ota.url, sha256: ota.sha256, size: ota.size},
        app: { executableSha256: data.app.executableSha256, javascriptSha256: data.app.javascriptSha256 } } };
  }
}
