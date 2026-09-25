import { createHash } from "node:crypto";
import { z } from "zod";
import type { OverviewJob, OverviewRequest } from "../types/test-run-overview.types";
import { readRequestZip, readTestMetadata } from "./test-builds.service";
import { TestRunGithubApp } from "./test-run-github-app";

const SOURCE = "Mentra-Community/MentraOS";
const PRIVATE = "Mentra-Community/Mentra-Automated-Testing";
const positive = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const shortText = z.string().min(1).max(240);
const date = z.string().datetime({ offset: true });
const runSchema = z.object({ id: positive, run_attempt: positive, path: z.string(), head_branch: z.string(), head_sha: sha,
  event: z.string(), status: z.string(), created_at: date, updated_at: date, display_title: shortText,
  conclusion: z.string().nullable().optional(),
  repository: z.object({ full_name: z.string() }), head_repository: z.object({ full_name: z.string() }) });
type Run = z.infer<typeof runSchema>;
const jobSchema = z.object({ id: positive, name: shortText, status: z.string(), started_at: date.nullable(),
  runner_name: z.string().max(240).nullable(), steps: z.array(z.object({ name: shortText, status: z.string() })).optional() });
const kinds = new Map<string, OverviewJob["kind"]>([
  [".github/workflows/device-routine.yml", "routine"],
  [".github/workflows/nightly-device-routines.yml", "nightly"],
  [".github/workflows/host-maintenance.yml", "maintenance"],
]);
const active = ["queued", "in_progress", "waiting", "pending", "requested"];
const url = (repository: string, id: number) => "https://github.com/" + repository + "/actions/runs/" + id;
const ensure = (value: unknown) => { if (!value) throw new Error("GitHub metadata identity differs"); };
const requestFields = z.object({ kind: z.literal("mentra-routine-request"), requestId: z.string().max(120),
  schemaVersion: z.union([z.literal(1), z.literal(2)]), status: z.literal("ready"),
  trigger: z.object({ repository: z.literal(SOURCE), workflow: z.literal(".github/workflows/request-e2e-routine.yml"),
    runId: positive, runAttempt: positive, sha, workflowSha: sha }),
  routine: z.object({ id: z.string().regex(/^[a-z0-9-]{1,120}$/), authorization: z.enum(["pr-label", "successful-build", "workflow-dispatch"]) }),
  pullRequest: z.object({ number: positive, headSha: sha }).optional(),
  source: z.object({ channel: z.enum(["dev", "staging"]), buildRunId: positive, publicationAttempt: positive }).optional(),
  sequence: z.object({ kind: z.literal("nightly-ota-call") }).optional(),
  selection: z.object({ platform: z.enum(["ios-on-mac", "ios", "android"]).optional(), producer: z.object({ runId: positive, publicationAttempt: positive }),
    build: z.object({ headSha: sha.optional(), sourceCommit: sha.optional(), releaseIdentity: shortText.optional() }) }),
});

export interface GithubOverview { jobs: OverviewJob[]; warnings: string[]; recentMaintenance?: OverviewJob[] }
export interface TestRunOverviewGateway { activity(options?: { fresh?: boolean }): Promise<GithubOverview> }

/** Read-only view of GitHub's actual queue. It does not dispatch or choose a worker. */
export class GithubTestRunOverview implements TestRunOverviewGateway {
  private readonly app: TestRunGithubApp;
  private readonly requests = new Map<string, OverviewRequest>();
  private readonly jobDetails = new Map<string, { until: number; jobs: z.infer<typeof jobSchema>[] }>();
  private cached?: { until: number; value: GithubOverview };
  private pending?: Promise<GithubOverview>;
  constructor(private readonly options: { fetch?: typeof fetch; token?: (scope: "source" | "private") => Promise<string>;
    app?: TestRunGithubApp; now?: () => number } = {}) { this.app = options.app ?? new TestRunGithubApp(); }
  private now() { return (this.options.now ?? Date.now)(); }
  private async fetch(input: string, init: RequestInit = {}) {
    return (this.options.fetch ?? fetch)(input, { ...init, redirect: init.redirect ?? "error", signal: AbortSignal.timeout(10_000) });
  }
  private async api(repository: string, path: string) {
    const scope = repository === PRIVATE ? "private" : "source";
    const token = await (this.options.token ? this.options.token(scope) : this.app.token(scope));
    return JSON.parse(new TextDecoder().decode(await readTestMetadata(await this.fetch(
      "https://api.github.com/repos/" + repository + path, { headers: { Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }), 4 * 1024 * 1024)));
  }
  async activity(options: { fresh?: boolean } = {}): Promise<GithubOverview> {
    // Administrative closure must re-read the queue, not rely on the view cache.
    if (options.fresh) return this.read();
    if (this.cached && this.cached.until > this.now()) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.read().then(value => { this.cached = { until: this.now() + 15_000, value }; return value; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async details(run: Run) {
    const key = run.id + "/" + run.run_attempt + "/" + run.status;
    const cached = this.jobDetails.get(key);
    if (cached && cached.until > this.now()) return cached.jobs;
    const data = z.object({ total_count: z.number(), jobs: z.array(jobSchema) }).parse(await this.api(PRIVATE,
      "/actions/runs/" + run.id + "/attempts/" + run.run_attempt + "/jobs?per_page=100"));
    ensure(data.total_count === data.jobs.length);
    if (this.jobDetails.size >= 500) this.jobDetails.delete(this.jobDetails.keys().next().value!);
    this.jobDetails.set(key, { until: this.now() + (run.status === "completed" ? 24 * 60 * 60_000 : 60_000), jobs: data.jobs });
    return data.jobs;
  }
  private async read(): Promise<GithubOverview> {
    const warnings: string[] = [];
    const pages = await Promise.allSettled(active.map(async status => {
      const data = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(runSchema) })
        .parse(await this.api(PRIVATE, "/actions/runs?status=" + status + "&per_page=100"));
      if (data.total_count > data.workflow_runs.length) warnings.push("GitHub's " + status + " queue exceeds the 100-run view limit; additional jobs are not shown.");
      return data.workflow_runs;
    }));
    const runs = new Map<number, Run>();
    pages.forEach((page, index) => {
      if (page.status === "rejected") { warnings.push("GitHub " + active[index] + " jobs could not be refreshed."); return; }
      for (const run of page.value) if (run.repository.full_name === PRIVATE && run.head_repository.full_name === PRIVATE
        && run.head_branch === "main" && run.event === "workflow_dispatch" && kinds.has(run.path) && active.includes(run.status)) runs.set(run.id, run);
    });
    const selected = [...runs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (selected.length > 100) warnings.push("The active worker view is limited to 100 jobs.");
    const jobs: OverviewJob[] = [];
    // Keep bounded concurrency; successful immutable request metadata is cached separately.
    for (let offset = 0; offset < Math.min(selected.length, 100); offset += 5)
      jobs.push(...await Promise.all(selected.slice(offset, Math.min(offset + 5, 100)).map(run => this.job(run))));
    let recentMaintenance: OverviewJob[] = [];
    try {
      const recent = z.object({ workflow_runs: z.array(runSchema) }).parse(await this.api(PRIVATE,
        "/actions/workflows/host-maintenance.yml/runs?event=workflow_dispatch&branch=main&status=completed&per_page=5"));
      recentMaintenance = await Promise.all(recent.workflow_runs.filter(run => run.repository.full_name === PRIVATE
        && run.head_repository.full_name === PRIVATE && run.path === ".github/workflows/host-maintenance.yml"
        && run.head_branch === "main" && run.status === "completed" && run.event === "workflow_dispatch"
        && this.now() - Date.parse(run.updated_at) <= 24 * 60 * 60 * 1000).map(run => this.job(run)));
    } catch { warnings.push("Recent host maintenance results could not be refreshed."); }
    return { jobs, warnings, recentMaintenance };
  }
  private async job(run: Run): Promise<OverviewJob> {
    const kind = kinds.get(run.path)!;
    const item: OverviewJob = { id: "github-" + run.id, kind, state: run.status === "completed" ? "finished" : run.status === "in_progress" ? "running"
      : run.status === "waiting" ? "waiting" : "queued", title: kind === "maintenance" ? "Host maintenance / recovery" : run.display_title,
      createdAt: run.created_at, requests: [], claims: [], workflow: { runId: run.id, url: url(PRIVATE, run.id),
        status: run.status, ...(run.conclusion ? { conclusion: run.conclusion } : {}), updatedAt: run.updated_at } };
    // Queued/requested/pending runs cannot provide a live assigned worker. Do not
    // spend one detail request per waiting item every time the page refreshes.
    if (["in_progress", "waiting", "completed"].includes(run.status)) try {
      const jobs = await this.details(run);
      const current = jobs.find(job => job.status === "in_progress") ?? jobs.find(job => job.status === "queued")
        ?? (run.status === "completed" ? jobs[0] : undefined);
      if (current) {
        if (current.runner_name) item.workerName = current.runner_name;
        if (current.status === "in_progress" && current.started_at) item.startedAt = current.started_at;
        const step = current.steps?.find(step => step.status === "in_progress");
        if (step) item.workflow!.step = step.name;
      }
    } catch { item.message = "GitHub job details are unavailable; routine progress is shown only when reported."; }
    if (kind === "maintenance") return item;
    const normal = /^(?:Device routine|Day-one OTA) request ([1-9]\d*) \/ attempt ([1-9]\d*)$/.exec(run.display_title);
    const nightly = /^Nightly OTA request ([1-9]\d*) then Call request ([1-9]\d*)$/.exec(run.display_title);
    const refs = kind === "nightly" && nightly ? [{ id: Number(nightly[1]) }, { id: Number(nightly[2]) }]
      : normal ? [{ id: Number(normal[1]), attempt: Number(normal[2]) }] : [];
    const metadata = await Promise.allSettled(refs.map(ref => this.request(ref.id, "attempt" in ref ? ref.attempt : undefined)));
    item.requests = metadata.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    if (!refs.length || metadata.some(result => result.status === "rejected"))
      item.message = "Some request/build details are unavailable; the GitHub job remains visible.";
    return item;
  }
  private async request(id: number, attempt?: number): Promise<OverviewRequest> {
    ensure(Number.isSafeInteger(id) && (!attempt || Number.isSafeInteger(attempt)));
    const key = id + "/" + (attempt ?? "unique");
    const cached = attempt ? this.requests.get(key) : undefined;
    if (cached) return cached;
    const artifacts = z.object({ total_count: z.number(), artifacts: z.array(z.object({ id: positive, name: z.string(), expired: z.boolean(),
      size_in_bytes: positive, digest: z.string(), workflow_run: z.object({ id: positive, head_sha: sha }) })) }).parse(
      await this.api(SOURCE, "/actions/runs/" + id + "/artifacts?per_page=100"));
    ensure(artifacts.total_count === artifacts.artifacts.length);
    const prefix = "mentra-routine-request-" + id + "-";
    const matching = artifacts.artifacts.filter(asset => attempt ? asset.name === prefix + attempt : asset.name.startsWith(prefix));
    ensure(matching.length === 1);
    const artifact = matching[0]!;
    const generation = Number(artifact.name.slice(prefix.length));
    ensure(Number.isSafeInteger(generation) && generation > 0 && !artifact.expired && artifact.size_in_bytes <= 2 * 1024 * 1024
      && artifact.workflow_run.id === id && /^sha256:[a-f0-9]{64}$/.test(artifact.digest));
    // A nightly title omits the attempt. Recheck uniqueness, then reuse the
    // already authenticated immutable generation instead of downloading it again.
    const authenticated = this.requests.get(id + "/" + generation);
    if (authenticated) return authenticated;
    const sourceRun = runSchema.parse(await this.api(SOURCE, "/actions/runs/" + id + "/attempts/" + generation));
    ensure(sourceRun.id === id && sourceRun.run_attempt === generation && sourceRun.repository.full_name === SOURCE
      && sourceRun.head_repository.full_name === SOURCE && sourceRun.path === ".github/workflows/request-e2e-routine.yml"
      && artifact.workflow_run.head_sha === sourceRun.head_sha);
    const token = await (this.options.token ? this.options.token("source") : this.app.token("source"));
    const redirect = await this.fetch("https://api.github.com/repos/" + SOURCE + "/actions/artifacts/" + artifact.id + "/zip",
      { redirect: "manual", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" } });
    ensure(redirect.status === 302);
    const location = new URL(redirect.headers.get("location") ?? "https://invalid.invalid");
    ensure(location.protocol === "https:" && !location.username && !location.password
      && (location.hostname.endsWith(".blob.core.windows.net") || location.hostname.endsWith(".actions.githubusercontent.com")));
    const bytes = await readTestMetadata(await this.fetch(location.href), 2 * 1024 * 1024);
    ensure("sha256:" + createHash("sha256").update(bytes).digest("hex") === artifact.digest);
    const request = requestFields.parse(readRequestZip(bytes));
    ensure(request.trigger.runId === id && request.trigger.runAttempt === generation && request.trigger.sha === sourceRun.head_sha);
    const pr = request.schemaVersion === 1 ? request.pullRequest : undefined;
    const source = request.schemaVersion === 2 ? request.source : undefined;
    ensure(pr || source);
    ensure(request.requestId === "routine-" + id + "-" + generation + "-" + (pr?.number ?? source!.channel) + "-" + request.routine.id);
    const result: OverviewRequest = { requestId: request.requestId, requestRunId: id, requestAttempt: generation,
      routineId: request.routine.id, trigger: request.sequence ? "nightly" : request.routine.authorization,
      ...(request.selection.platform ? { platform: request.selection.platform } : {}),
      channel: pr ? "pr" : source!.channel, ...(pr ? { prNumber: pr.number, headSha: pr.headSha } : {}),
      ...(request.selection.build.releaseIdentity ? { release: request.selection.build.releaseIdentity } : {}),
      ...(!pr && request.selection.build.sourceCommit ? { headSha: request.selection.build.sourceCommit } : {}),
      buildRunId: request.selection.producer.runId, publicationAttempt: request.selection.producer.publicationAttempt };
    if (this.requests.size >= 500) this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(id + "/" + generation, result);
    return result;
  }
}
