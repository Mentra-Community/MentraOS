import {expect, test} from "bun:test";
import {GithubTestBuildGateway} from "./test-builds.service";
import {createHash} from "node:crypto";
const REPO = "Mentra-Community/MentraOS";
const API = `https://api.github.com/repos/${REPO}`;
const CDN = `https://artifactscdn.mentraglass.com/${REPO}/releases/`;
const HEAD = "a".repeat(40), BASE = "b".repeat(40), MERGE = "c".repeat(40), HASH = "d".repeat(64);
const run = (extra = {}) => ({ id: 50, run_attempt: 1, head_sha: HEAD, head_branch: "candidate", path: ".github/workflows/mentra-app-ios-build.yml",
  event: "pull_request", status: "completed", conclusion: "success", created_at: "2026-09-23T01:00:00Z", display_title: "Candidate",
  repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...extra });
const pr = { number: 12, state: "open", title: "Candidate", head: { sha: HEAD, ref: "candidate", repo: { full_name: REPO } }, base: { ref: "dev" } };
const jobs = ["build", "publish"].map((name, index) => ({ id: index + 1, name, run_attempt: 1, status: "completed", conclusion: "success",
  started_at: "2026-09-23T01:00:00Z", completed_at: "2026-09-23T01:10:00Z" }));
function fixture() {
  const rows = new Map<string, unknown>();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const value = rows.get(`${init?.method ?? "GET"} ${url}`) ?? rows.get(url);
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value.clone();
    return value === undefined ? new Response("missing", { status: 404 }) : Response.json(value);
  }) as typeof globalThis.fetch;
  const receipt = { schemaVersion: 2, pr: 12, headSha: HEAD, runId: 50, runAttempt: 1, buildSha: MERGE,
    app: { bundleId: "com.mentra.mentra", teamId: "T5XXXL6N36", backend: "dev", headSha: HEAD, buildSha: MERGE, runId: 50, runAttempt: 1,
      executableSha256: HASH, javascriptSha256: HASH, otaManifestUrl: `${CDN}pr-builds/ota-pr-12-${HEAD}.json` },
    artifacts: { mac: { name: `mentra-ios-mac-pr-12-${HEAD}-50-1.zip`, sha256: HASH, size: 100 } } };
  rows.set(`${API}/pulls/12`, pr);
  rows.set(`${API}/git/ref/heads/dev`, { ref: "refs/heads/dev", object: { type: "commit", sha: BASE } });
  rows.set(`${API}/actions/runs/50/attempts/1`, run());
  rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: jobs.length, jobs });
  rows.set(`${CDN}pr-builds/mentra-ios-pr-12-${HEAD}-50-1.json`, receipt);
  rows.set(`${CDN}pr-builds/ota-pr-12-${HEAD}.json`, { releaseVersion: `pr-12-${HEAD}` });
  rows.set(`${API}/commits/${MERGE}`, { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] });
  rows.set(`HEAD ${CDN}pr-builds/${receipt.artifacts.mac.name}`, new Response(null, { headers: { "Content-Length": "100" } }));
  return { rows, calls, fetch, receipt, gateway: new GithubTestBuildGateway({ token: "test-only-token", fetch }) };
}

test("published PR archive retains identity and read-only discovery", async () => {
 const f = fixture();
 const selected = await f.gateway.resolve({channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}, "ios-on-mac");
 expect(selected.availability).toBe("available"); expect(selected.archive?.sha256).toBe(HASH);
 expect(selected.archive?.url).toBe(`${CDN}pr-builds/${f.receipt.artifacts.mac.name}`);
 const bytes = JSON.stringify({releaseVersion: `pr-12-${HEAD}`});
 expect(selected.manifest).toEqual({url: `${CDN}pr-builds/ota-pr-12-${HEAD}.json`,
  sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes)});
 expect(selected.manifestSha256).toBe(selected.manifest!.sha256);
 expect(f.calls.every(call => !call.init?.method || ["GET", "HEAD"].includes(call.init.method))).toBe(true);
});

test("Android PR publication retains the exact manifest beside its APK and original digest", async () => {
 const f = fixture(), name = `mentra-android-pr-12-${HEAD}-50-1`;
 f.rows.set(`${API}/actions/runs/50/attempts/1`, run({path: ".github/workflows/mentra-app-android-build.yml"}));
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [{...jobs[0]!,
  steps: [{name: "Upload APK to the public artifact CDN", status: "completed", conclusion: "success"}]}]});
 f.rows.set(`${CDN}pr-builds/${name}.json`, {schemaVersion: 1, pr: 12, headSha: HEAD, baseSha: BASE, buildSha: MERGE, runId: 50, runAttempt: 1,
  app: {packageId: "com.mentra.mentra", version: "3.2.1", build: "20", headSha: HEAD, buildSha: MERGE, backend: "dev",
   otaManifestUrl: `${CDN}pr-builds/ota-pr-12-${HEAD}.json`}, artifacts: {android: {name: `${name}.apk`, sha256: HASH, size: 100}}});
 f.rows.set(`HEAD ${CDN}pr-builds/${name}.apk`, new Response(null, {headers: {"Content-Length": "100"}}));
 const selected = await f.gateway.resolve({channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}, "android");
 const bytes = JSON.stringify({releaseVersion: `pr-12-${HEAD}`});
 expect(selected).toMatchObject({availability: "available", archive: {name: `${name}.apk`},
  manifest: {url: `${CDN}pr-builds/ota-pr-12-${HEAD}.json`, sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes)}});
 expect(selected.manifestSha256).toBe(selected.manifest!.sha256);
});
test("wrong archive size and moved PR base cannot become selectable", async () => {
 for (const kind of ["size", "base"]) {
  const f = fixture();
  if (kind === "size") f.rows.set(`HEAD ${CDN}pr-builds/${f.receipt.artifacts.mac.name}`, new Response(null, {headers: {"Content-Length": "99"}}));
  else f.rows.set(`${API}/git/ref/heads/dev`, {ref: "refs/heads/dev", object: {type: "commit", sha: "e".repeat(40)}});
  expect((await f.gateway.resolve({channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}, "ios-on-mac")).availability).toBe("unavailable");
 }
});

test("PR inventory exposes only the current same-repository head with verified published artifacts", async () => {
 const f = fixture();
 f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=10`, {
  workflow_runs: [run(), run({id: 51, head_sha: BASE}), run({id: 52, head_repository: {full_name: "external/fork"}})],
 });
 const builds = await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"});
 expect(builds).toHaveLength(1);
 expect(builds[0]).toMatchObject({availability: "available", headSha: HEAD,
  source: {channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}});
 expect(builds[0]!.archive?.url).toBe(`${CDN}pr-builds/${f.receipt.artifacts.mac.name}`);
 expect(f.calls.some(call => /actions\/runs\/(51|52)\//.test(call.url))).toBe(false);
});

test("dev inventory distinguishes a newer unpublished build from the previous immutable Mac release", async () => {
 const f = fixture();
 const identity = "3.2.1-dev.20", tag = "mentra-builds-v3.2.1";
 f.rows.set(`${API}/actions/workflows/coordinated-release.yml/runs?branch=dev&per_page=10`, {
  workflow_runs: [run({id: 60, head_branch: "dev", event: "push", path: ".github/workflows/coordinated-release.yml", status: "in_progress", conclusion: null}),
   run({head_branch: "dev", event: "push", path: ".github/workflows/coordinated-release.yml"})],
 });
 f.rows.set(`${API}/actions/runs/60/jobs?filter=all&per_page=100&page=1`, {total_count: 0, jobs: []});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [{id: 70,
  name: "Finalize immutable release bill of materials", run_attempt: 1, status: "completed", conclusion: "success",
  started_at: "2026-09-23T01:00:00Z", completed_at: "2026-09-23T01:10:00Z",
  steps: [{name: "Publish immutable plan, package, and manifest assets", status: "completed", conclusion: "success"}]}]});
 f.rows.set(`${API}/actions/runs/50/artifacts?per_page=100`, {artifacts: [{name: `coordinated-release-plan-mentra-${identity}`,
  expired: false, workflow_run: {id: 50, head_sha: HEAD}}]});
 f.rows.set(`${CDN}${tag}/mentra-release-plan-${identity}.json`, {releaseIdentity: identity, sourceCommit: HEAD, channel: "dev",
  artifactContainerTag: tag, native: {buildNumber: 20, marketingVersion: "3.2.1"}, artifactNames: {otaManifest: `mentra-live-ota-${identity}.json`}});
 const archive = {name: `mentraos-${identity}-mac.zip`, sha256: HASH, size: 100};
 f.rows.set(`${CDN}${tag}/mentraos-${identity}-apple-downloads.json`, {schemaVersion: 1, releaseIdentity: identity, sourceCommit: HEAD,
  app: {bundleId: "com.mentra.mentra", headSha: HEAD, backend: "dev", build: "20", version: "3.2.1",
   otaManifestUrl: `${CDN}${tag}/mentra-live-ota-${identity}.json`, executableSha256: HASH, javascriptSha256: HASH}, artifacts: {mac: archive}});
 f.rows.set(`${CDN}${tag}/mentra-live-ota-${identity}.json`, {releaseVersion: identity});
 f.rows.set(`HEAD ${CDN}${tag}/${archive.name}`, new Response(null, {headers: {"Content-Length": "100"}}));
 const builds = await f.gateway.inventory({channel: "dev", platform: "ios-on-mac"});
 expect(builds[0]).toMatchObject({availability: "unavailable", source: {buildRunId: 60}, reason: "Selected coordinated attempt did not publish immutable assets"});
 const available = builds.filter(build => build.availability === "available");
 expect(available).toHaveLength(1);
 expect(available[0]).toMatchObject({headSha: HEAD, release: identity, source: {channel: "dev", buildRunId: 50, publicationAttempt: 1}, archive});
 expect(available[0]!.archive?.url).toBe(`${CDN}${tag}/${archive.name}`);
});


const before = "2026-09-23T11:00:00Z";
const nightlyUrl = `${API}/actions/workflows/coordinated-release.yml/runs?branch=dev&created=<=${encodeURIComponent(before)}&per_page=100&page=1`;
const finalizer = {id: 70, name: "Finalize immutable release bill of materials", run_attempt: 1, status: "completed", conclusion: "success",
  started_at: "2026-09-23T01:00:00Z", completed_at: "2026-09-23T01:10:00Z",
  steps: [{name: "Publish immutable plan, package, and manifest assets", status: "completed", conclusion: "success"}]};
const releaseRun = (extra = {}) => run({head_branch: "dev", event: "push", path: ".github/workflows/coordinated-release.yml", ...extra});
function nightlyFixture() {
 const f = fixture();
 const identity = "3.2.1-dev.20", tag = "mentra-builds-v3.2.1";
 f.rows.set(`${API}/actions/runs/60/jobs?filter=all&per_page=100&page=1`, {total_count: 0, jobs: []});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [finalizer]});
 f.rows.set(`${API}/actions/runs/50/artifacts?per_page=100`, {artifacts: [{name: `coordinated-release-plan-mentra-${identity}`,
  expired: false, workflow_run: {id: 50, head_sha: HEAD}}]});
 f.rows.set(`${CDN}${tag}/mentra-release-plan-${identity}.json`, {releaseIdentity: identity, sourceCommit: HEAD, channel: "dev",
  artifactContainerTag: tag, native: {buildNumber: 20, marketingVersion: "3.2.1"}, artifactNames: {otaManifest: `mentra-live-ota-${identity}.json`}});
 const archive = {name: `mentraos-${identity}-mac.zip`, sha256: HASH, size: 100};
 f.rows.set(`${CDN}${tag}/mentraos-${identity}-apple-downloads.json`, {schemaVersion: 1, releaseIdentity: identity, sourceCommit: HEAD,
  app: {bundleId: "com.mentra.mentra", headSha: HEAD, backend: "dev", build: "20", version: "3.2.1",
   otaManifestUrl: `${CDN}${tag}/mentra-live-ota-${identity}.json`, executableSha256: HASH, javascriptSha256: HASH}, artifacts: {mac: archive}});
 f.rows.set(`${CDN}${tag}/mentra-live-ota-${identity}.json`, {releaseVersion: identity});
 f.rows.set(`HEAD ${CDN}${tag}/${archive.name}`, new Response(null, {headers: {"Content-Length": "100"}}));
 f.rows.set(nightlyUrl, {total_count: 2, workflow_runs: [releaseRun({id: 60, status: "in_progress", conclusion: null}), releaseRun()]});
 return {...f, archive, planUrl: `${CDN}${tag}/mentra-release-plan-${identity}.json`};
}

test("coordinated Android publication retains source-bound manifest URL, size and digest", async () => {
 const f = nightlyFixture(), identity = "3.2.1-dev.20", tag = "mentra-builds-v3.2.1";
 const plan = f.rows.get(f.planUrl) as {native: {buildNumber: number; marketingVersion: string}; artifactNames: Record<string, string>};
 plan.artifactNames.androidApp = `mentraos-${identity}-android.apk`;
 plan.artifactNames.releaseManifest = `mentra-release-${identity}.json`;
 f.rows.set(`${API}/actions/runs/50/attempts/1`, releaseRun());
 f.rows.set(`${CDN}${tag}/${plan.artifactNames.releaseManifest}`, {schemaVersion: 1, releaseIdentity: identity, releaseSetId: `mentra-${identity}`,
  sourceCommit: HEAD, releasePlanSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"), channel: "dev", native: plan.native,
  artifacts: [{coordinate: plan.artifactNames.androidApp, url: `${CDN}${tag}/${plan.artifactNames.androidApp}`, sha256: HASH, size: 100, status: "published"}]});
 f.rows.set(`HEAD ${CDN}${tag}/${plan.artifactNames.androidApp}`, new Response(null, {headers: {"Content-Length": "100"}}));
 const selected = await f.gateway.resolve({channel: "dev", buildRunId: 50, publicationAttempt: 1}, "android");
 const bytes = JSON.stringify({releaseVersion: identity});
 expect(selected).toMatchObject({availability: "available", release: identity, manifest: {url: `${CDN}${tag}/mentra-live-ota-${identity}.json`,
  sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes)}});
 expect(selected.manifestSha256).toBe(selected.manifest!.sha256);
});

test("nightly latest dev selection passes newer unpublished runs and pins the publication before its boundary", async () => {
 const f = nightlyFixture();
 const selected = await f.gateway.latestDev("ios-on-mac", before);
 expect(selected).toMatchObject({availability: "available", source: {channel: "dev", buildRunId: 50, publicationAttempt: 1}, archive: f.archive});
 const bytes = JSON.stringify({releaseVersion: "3.2.1-dev.20"});
 expect(selected!.manifest).toEqual({url: `${CDN}mentra-builds-v3.2.1/mentra-live-ota-3.2.1-dev.20.json`,
  sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes)});
 expect(selected!.manifestSha256).toBe(selected!.manifest!.sha256);
 expect(f.calls.every(call => !call.init?.method || ["GET", "HEAD"].includes(call.init.method))).toBe(true);
});

test("nightly latest dev refuses truncated history and transient GitHub job metadata instead of selecting older releases", async () => {
 const before = "2026-09-23T11:00:00Z", url = `${API}/actions/workflows/coordinated-release.yml/runs?branch=dev&created=<=${encodeURIComponent(before)}&per_page=100&page=1`;
 const f = fixture();
 f.rows.set(url, {total_count: 2, workflow_runs: [run({head_branch: "dev", event: "push", path: ".github/workflows/coordinated-release.yml"})]});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 0, jobs: []});
 await expect(f.gateway.latestDev("android", before)).rejects.toThrow("incomplete");
 f.rows.set(url, {total_count: 1, workflow_runs: [run({head_branch: "dev", event: "push", path: ".github/workflows/coordinated-release.yml"})]});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, new Response("unavailable", {status: 503}));
 await expect(f.gateway.latestDev("android", before)).rejects.toThrow("unavailable");
});

test("post-boundary retries cannot erase the available original nightly publication", async () => {
 for (const retry of [
  {status: "in_progress", conclusion: null, completed_at: null},
  {status: "completed", conclusion: "failure", completed_at: "2026-09-23T12:10:00Z"},
  {status: "completed", conclusion: "success", completed_at: "2026-09-23T12:10:00Z"},
 ]) {
  const f = nightlyFixture();
  f.rows.set(nightlyUrl, {total_count: 1, workflow_runs: [releaseRun({run_attempt: 2})]});
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 2,
   jobs: [finalizer, {...finalizer, id: 71, run_attempt: 2, started_at: "2026-09-23T12:00:00Z", ...retry}]});
  expect(await f.gateway.latestDev("ios-on-mac", before)).toMatchObject({availability: "available",
   source: {buildRunId: 50, publicationAttempt: 1}, archive: f.archive});
 }
});

test("an execution begun by the boundary supersedes earlier attempts but must finish by the boundary to publish", async () => {
 for (const started_at of ["2026-09-23T10:59:59Z", before]) {
  const f = nightlyFixture();
  f.rows.set(nightlyUrl, {total_count: 1, workflow_runs: [releaseRun({run_attempt: 2})]});
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 2,
   jobs: [finalizer, {...finalizer, id: 71, run_attempt: 2, started_at, completed_at: "2026-09-23T11:00:01Z"}]});
  expect(await f.gateway.latestDev("ios-on-mac", before)).toBeNull();
 }
 const f = nightlyFixture();
 f.rows.set(nightlyUrl, {total_count: 1, workflow_runs: [releaseRun({run_attempt: 2})]});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 2,
  jobs: [finalizer, {...finalizer, id: 71, run_attempt: 2, started_at: "2026-09-23T10:59:59Z", completed_at: before}]});
 expect(await f.gateway.latestDev("ios-on-mac", before)).toMatchObject({availability: "available", source: {publicationAttempt: 2}});
});

test("retained finalizer rows pin their original attempt and CDN failures do not select an older release", async () => {
 const f = nightlyFixture();
 f.rows.set(nightlyUrl, {total_count: 1, workflow_runs: [releaseRun({run_attempt: 2})]});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 2,
  jobs: [finalizer, {...finalizer, id: 71, run_attempt: 2}]});
 expect(await f.gateway.latestDev("ios-on-mac", before)).toMatchObject({availability: "available", source: {publicationAttempt: 1}});
 f.rows.set(f.planUrl, new Response("unavailable", {status: 503}));
 await expect(f.gateway.latestDev("ios-on-mac", before)).rejects.toThrow("Build metadata unavailable (HTTP 503)");
});
