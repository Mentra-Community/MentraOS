import {expect, test} from "bun:test";
import {selectedBuildInput, testBuildQuerySchema, testBuildSourceSchema} from '../types/test-build.types';
import {GithubTestBuildGateway} from "./test-builds.service";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {RoutineJobService} from './routine-job.service';
import {PrRoutineCheckService} from './pr-routine-check.service';
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
 for (const workflow of ['mentra-app-android-build.yml', 'mentra-app-ios-build.yml']) {
  rows.set(`${API}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=dev&per_page=100&page=1`, {workflow_runs: []});
  rows.set(`${API}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`, {workflow_runs: []});
 }
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
test("wrong archive size and moved PR base cannot become newly selectable", async () => {
 for (const kind of ["size", "base"]) {
  const f = fixture();
  if (kind === "size") f.rows.set(`HEAD ${CDN}pr-builds/${f.receipt.artifacts.mac.name}`, new Response(null, {headers: {"Content-Length": "99"}}));
  else f.rows.set(`${API}/git/ref/heads/dev`, {ref: "refs/heads/dev", object: {type: "commit", sha: "e".repeat(40)}});
  f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`, {workflow_runs: [run()]});
  expect((await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"}))[0]!.availability).toBe("unavailable");
 }
});

test("an immutable Mac publication survives base advance without changing original references", async () => {
 const f = fixture(), source = {channel: "pr" as const, prNumber: 12, buildRunId: 50, publicationAttempt: 1};
 const original = await f.gateway.resolve(source, "ios-on-mac");
 f.rows.set(`${API}/git/ref/heads/dev`, {ref: "refs/heads/dev", object: {type: "commit", sha: "e".repeat(40)}});
 f.calls.length = 0;
 expect(await f.gateway.resolve(source, "ios-on-mac")).toEqual(original);
 expect(f.calls.some(call => call.url === `${API}/git/ref/heads/dev`)).toBe(false);
 for (const commit of [
  {sha: "e".repeat(40), parents: [{sha: BASE}, {sha: HEAD}]},
  {sha: MERGE, parents: [{sha: BASE}, {sha: "e".repeat(40)}]},
  {sha: MERGE, parents: [{sha: BASE}]},
 ]) {
  f.rows.set(`${API}/commits/${MERGE}`, commit);
  expect((await f.gateway.resolve(source, "ios-on-mac")).availability).toBe("unavailable");
 }
});

test("an immutable Android publication verifies its recorded base after dev advances", async () => {
 const f = fixture(), name = `mentra-android-pr-12-${HEAD}-50-1`;
 const androidRun = run({path: ".github/workflows/mentra-app-android-build.yml"});
 f.rows.set(`${API}/actions/runs/50/attempts/1`, androidRun);
 f.rows.set(`${API}/actions/workflows/mentra-app-android-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`, {workflow_runs: [androidRun]});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [{...jobs[0]!,
  steps: [{name: "Upload APK to the public artifact CDN", status: "completed", conclusion: "success"}]}]});
 const receipt = {schemaVersion: 1, pr: 12, headSha: HEAD, baseSha: BASE, buildSha: MERGE, runId: 50, runAttempt: 1,
  app: {packageId: "com.mentra.mentra", version: "3.2.1", build: "20", headSha: HEAD, buildSha: MERGE, backend: "dev",
   otaManifestUrl: `${CDN}pr-builds/ota-pr-12-${HEAD}.json`}, artifacts: {android: {name: `${name}.apk`, sha256: HASH, size: 100}}};
 f.rows.set(`${CDN}pr-builds/${name}.json`, receipt);
 f.rows.set(`HEAD ${CDN}pr-builds/${name}.apk`, new Response(null, {headers: {"Content-Length": "100"}}));
 const source = {channel: "pr" as const, prNumber: 12, buildRunId: 50, publicationAttempt: 1};
 const original = await f.gateway.resolve(source, "android");
 expect(original.availability).toBe("available");
 f.rows.set(`${API}/git/ref/heads/dev`, {ref: "refs/heads/dev", object: {type: "commit", sha: "e".repeat(40)}});
 f.calls.length = 0;
 expect(await f.gateway.resolve(source, "android")).toEqual(original);
 expect(f.calls.some(call => call.url === `${API}/git/ref/heads/dev`)).toBe(false);
 expect((await f.gateway.inventory({channel: "pr", pr: 12, platform: "android"}))[0]!.availability).toBe("unavailable");
 for (const commit of [
  {sha: MERGE, parents: [{sha: "e".repeat(40)}, {sha: HEAD}]},
  {sha: MERGE, parents: [{sha: BASE}, {sha: "e".repeat(40)}]},
  {sha: "e".repeat(40), parents: [{sha: BASE}, {sha: HEAD}]},
 ]) {
  f.rows.set(`${API}/commits/${MERGE}`, commit);
  expect((await f.gateway.resolve(source, "android")).availability).toBe("unavailable");
 }
 f.rows.set(`${API}/commits/${MERGE}`, {sha: MERGE, parents: [{sha: BASE}, {sha: HEAD}]});
 for (const changed of [{...receipt, runAttempt: 2}, {...receipt, baseSha: "e".repeat(40)}, {...receipt, headSha: "e".repeat(40)}]) {
  f.rows.set(`${CDN}pr-builds/${name}.json`, changed);
  expect((await f.gateway.resolve(source, "android")).availability).toBe("unavailable");
 }
});

test("PR inventory exposes only the current same-repository head with verified published artifacts", async () => {
 const f = fixture();
 f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`, {
  workflow_runs: [run(), run({id: 51, head_sha: BASE}), run({id: 52, head_repository: {full_name: "external/fork"}})],
 });
 const builds = await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"});
 expect(builds).toHaveLength(1);
 expect(builds[0]).toMatchObject({availability: "available", headSha: HEAD,
  source: {channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}});
 expect(builds[0]!.archive?.url).toBe(`${CDN}pr-builds/${f.receipt.artifacts.mac.name}`);
 expect(f.calls.some(call => /actions\/runs\/(51|52)\//.test(call.url))).toBe(false);
});

test("PR inventory finds the current publication beyond a full first page", async () => {
 const f = fixture(), inventory = `${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=`;
 f.rows.set(`${inventory}1`, {workflow_runs: Array.from({length: 100}, (_, index) => run({id: 1000 + index, head_sha: BASE}))});
 f.rows.set(`${inventory}2`, {workflow_runs: [run()]});
 const builds = await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"});
 expect(builds).toHaveLength(1);
 expect(builds[0]).toMatchObject({availability: "available", headSha: HEAD,
  source: {channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}});
 expect(f.calls.filter(call => call.url.startsWith(inventory)).map(call => call.url)).toEqual([`${inventory}1`, `${inventory}2`]);
 expect(f.calls.some(call => /actions\/runs\/10\d\d\//.test(call.url))).toBe(false);
});

test("PR inventory keeps exact publication selectable despite more than 500 unrelated executions", async () => {
 const f = fixture(), inventory = `${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=`;
 for (let page = 1; page <= 5; page++) {
  const workflowRuns = Array.from({length: 100}, (_, index) => run({id: page * 1000 + index, head_sha: BASE}));
  if (page === 1) workflowRuns[0] = run();
  f.rows.set(`${inventory}${page}`, {workflow_runs: workflowRuns});
 }
 const selected = await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"});
 expect(selected).toHaveLength(1); expect(selected[0]!.availability).toBe('available');
 expect(f.calls.filter(call => call.url.startsWith(inventory))).toHaveLength(5);
 expect(f.calls.some(call => /actions\/runs\/10\d\d\//.test(call.url))).toBe(false);
});

test("trusted PR dispatch inventory binds its exact title and verifies the published PR merge", async () => {
 const f = fixture(), inventory = `${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`;
 const dispatched = run({event: "workflow_dispatch", head_branch: "dev", head_sha: BASE,
  display_title: `Routine PR #12 ${HEAD} dev`});
 f.rows.set(inventory, {workflow_runs: [dispatched,
  run({...dispatched, id: 51, display_title: `Routine PR #13 ${HEAD} dev`}),
  run({...dispatched, id: 52, display_title: `Routine PR #12 ${BASE} dev`}),
  run({...dispatched, id: 53, display_title: `Routine PR #12 ${HEAD} staging`}),
  run({...dispatched, id: 54, head_branch: "candidate"}),
  run({...dispatched, id: 55, head_repository: {full_name: "external/fork"}})]});
 expect(await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"})).toMatchObject([
  {availability: "available", headSha: HEAD, source: {channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}},
 ]);
 expect(f.calls.some(call => /actions\/runs\/5[1-5]\//.test(call.url))).toBe(false);
 f.rows.set(`${API}/commits/${MERGE}`, {sha: MERGE, parents: [{sha: BASE}, {sha: BASE}]});
 expect((await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"}))[0]).toMatchObject({
  availability: "unavailable", reason: "Mac build does not contain the selected PR head and base",
 });
});

test("trusted PR dispatch inventory accepts only an exact retained correlation suffix or the exact manual title", async () => {
 for (const title of [`Routine PR #12 ${HEAD} dev`, `Routine PR #12 ${HEAD} dev ${HASH}`]) {
  const f = fixture(), dispatched = run({event: "workflow_dispatch", head_branch: "dev", head_sha: BASE, display_title: title});
  f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`, {workflow_runs: [dispatched,
   run({...dispatched, id: 51, display_title: `Routine PR #12 ${HEAD} dev ${HASH.slice(1)}`}),
   run({...dispatched, id: 52, display_title: `Routine PR #12 ${HEAD} dev ${"g".repeat(64)}`}),
   run({...dispatched, id: 53, display_title: `Routine PR #12 ${HEAD} dev ${HASH} trailing`}),
   run({...dispatched, id: 54, display_title: `Routine PR #12 ${HEAD} dev ${HASH.toUpperCase()}`})]});
  const builds = await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"});
  expect(builds).toHaveLength(1);
  expect(builds[0]).toMatchObject({availability: "available", source: {buildRunId: 50}, headSha: HEAD});
  expect(f.calls.some(call => /actions\/runs\/5[1-4]\//.test(call.url))).toBe(false);
 }
});

test("an unavailable requested PR producer distinguishes a terminal failure from an active build", async () => {
 for (const active of [false, true]) {
  const f = fixture(), producer = run({event: "workflow_dispatch", head_branch: "dev", head_sha: BASE,
   display_title: `Routine PR #12 ${HEAD} dev`, status: active ? "in_progress" : "completed", conclusion: active ? null : "failure"});
  f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`, {workflow_runs: [producer]});
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1,
   jobs: [{...jobs[0]!, status: producer.status, conclusion: producer.conclusion}]});
  const builds = await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac"});
  expect(builds).toHaveLength(1);
  expect(builds[0]).toMatchObject({availability: "unavailable", producerStatus: active ? "pending" : "failed",
   source: {channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}, reason: "Build or Mac publication has not succeeded"});
 }
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
  expired: false, workflow_run: {id: 50, head_sha: HEAD}}, {name: `coordinated-release-result-mentra-${identity}`,
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
const CANONICAL_REPO = "Mentra-Community/Mentra", CANONICAL_API = "https://api.github.com/repos/" + CANONICAL_REPO;
const CANONICAL_HEAD = "d8b2130461973d8daaaedbabd4a9a636de7544eb";
const EXPORTED_HEAD = "b833ec868955b13601a917f81889bfa02194902f";
const EXPORTED_ORIGIN = "2a5d4cc927c1c514bdb0df783cbd836c048677c3";
function canonicalFixture() {
 const f = fixture(), id = 40098925744, identity = "3.4.0-dev.1097", tag = "mentra-builds-v3.4.0";
 const producer = run({id, head_sha: CANONICAL_HEAD, head_branch: "dev", event: "push",
  path: ".github/workflows/release.yml", repository: {full_name: CANONICAL_REPO}, head_repository: {full_name: CANONICAL_REPO},
  created_at: "2026-10-24T13:37:00Z"});
 const job = {...finalizer, id: 120900127899, name: "finalize / Finalize the release manifest and tag",
  started_at: "2026-10-24T14:37:00Z", completed_at: "2026-10-24T14:39:00Z"};
 f.rows.set(CANONICAL_API + "/actions/runs/" + id + "/attempts/1", producer);
 f.rows.set(CANONICAL_API + "/actions/runs/" + id + "/jobs?filter=all&per_page=100&page=1", {total_count: 1, jobs: [job]});
 f.rows.set(CANONICAL_API + "/actions/workflows/release.yml/runs?branch=dev&per_page=10", {workflow_runs: [producer]});
 f.rows.set(CANONICAL_API + "/actions/workflows/release.yml/runs?branch=dev&created=<=" +
  encodeURIComponent("2026-10-25T11:00:00Z") + "&per_page=100&page=1", {total_count: 1, workflow_runs: [producer]});
 const releaseRef = {ref: "refs/tags/mentra-v" + identity, object: {type: "commit", sha: EXPORTED_HEAD}};
 f.rows.set(API + "/git/matching-refs/tags/mentra-v", [releaseRef]);
 f.rows.set(API + "/git/commits/" + EXPORTED_HEAD, {sha: EXPORTED_HEAD, message: "Export\n\nGitOrigin-RevId: " + EXPORTED_ORIGIN});
 const compare = {status: "ahead", base_commit: {sha: EXPORTED_ORIGIN}, merge_base_commit: {sha: EXPORTED_ORIGIN},
  total_commits: 1, commits: [{sha: CANONICAL_HEAD}], files: [{filename: "testing/orchestration/fixer/provider.ts"}]};
 f.rows.set(CANONICAL_API + "/compare/" + EXPORTED_ORIGIN + "..." + CANONICAL_HEAD, compare);
 const native = {buildNumber: 304000083, marketingVersion: "3.4.0", googlePlayUpload: false, playTrack: "internal"};
 const plan = {releaseIdentity: identity, sourceCommit: EXPORTED_HEAD, channel: "dev", artifactContainerTag: tag,
  native, artifactNames: {otaManifest: "mentra-live-ota-" + identity + ".json", androidApp: "mentraos-" + identity + "-android.apk",
   releaseManifest: "mentra-release-" + identity + ".json"}};
 const planUrl = CDN + tag + "/mentra-release-plan-" + identity + ".json";
 const manifestUrl = CDN + tag + "/" + plan.artifactNames.releaseManifest;
 const asset = {coordinate: plan.artifactNames.androidApp, url: CDN + tag + "/" + plan.artifactNames.androidApp,
  sha256: "957d0b2f54c22f71031d619b27467307c0756da734696a6de29df4f6c3205ee4", size: 329371158,
  status: "published", provenanceUrl: "https://github.com/" + CANONICAL_REPO + "/actions/runs/" + id};
 const manifest = {schemaVersion: 1, releaseIdentity: identity, releaseSetId: "mentra-" + identity,
  sourceCommit: EXPORTED_HEAD, releasePlanSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  channel: "dev", native, artifacts: [asset]};
 f.rows.set(planUrl, plan); f.rows.set(manifestUrl, manifest);
 f.rows.set(CDN + tag + "/" + plan.artifactNames.otaManifest, {releaseVersion: identity});
 f.rows.set("HEAD " + asset.url, new Response(null, {headers: {"Content-Length": String(asset.size)}}));
 const familyPath = CANONICAL_API + "/contents/public/mentraos/.github/release-family.json?ref=" + CANONICAL_HEAD;
 const familyBytes = readFileSync(new URL("../../../../../.github/release-family.json", import.meta.url), "utf8");
 f.rows.set(familyPath, {type: "file", path: "public/mentraos/.github/release-family.json", encoding: "base64",
  size: Buffer.byteLength(familyBytes), content: Buffer.from(familyBytes).toString("base64")});
 const versionPath = CANONICAL_API + "/contents/public/mentraos/package.json?ref=" + CANONICAL_HEAD;
 const versionBytes = JSON.stringify({name: "mentraos", version: "3.4.0"});
 f.rows.set(versionPath, {type: "file", path: "public/mentraos/package.json", encoding: "base64",
  size: Buffer.byteLength(versionBytes), content: Buffer.from(versionBytes).toString("base64")});
 const indexUrl = CDN + tag + "/_assets.json";
 const indexAsset = {name: plan.artifactNames.releaseManifest, size: 0, digest: "sha256:" + HASH,
  state: "uploaded", browser_download_url: manifestUrl, created_at: "2026-10-24T14:38:00Z"};
 const index = {schemaVersion: 1, repository: REPO, tag, assets: [indexAsset]};
 const refreshIndex = () => {const bytes = JSON.stringify(f.rows.get(manifestUrl));
  indexAsset.size = Buffer.byteLength(bytes); indexAsset.digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");};
 refreshIndex(); f.rows.set(indexUrl, index);
 const source = {repository: CANONICAL_REPO as "Mentra-Community/Mentra", channel: "dev" as const, buildRunId: id, publicationAttempt: 1};
 return {...f, id, identity, producer, job, releaseRef, compare, plan, planUrl, manifest, manifestUrl, asset, source, familyPath, versionPath, index, indexUrl, indexAsset, refreshIndex};
}

test("canonical finalized CDN manifests do not depend on live public tag discovery", async () => {
 for (const tags of [[], new Response("request limit reached", {status: 403,
  headers: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793066874"}}),
  [{ref: "refs/tags/mentra-v3.4.0-dev.1097", object: {type: "commit", sha: HEAD}}]]) {
  const f = canonicalFixture(); f.rows.set(API + "/git/matching-refs/tags/mentra-v", tags);
  expect(await f.gateway.resolve(f.source, "android")).toMatchObject({availability: "available",
   release: f.identity, headSha: CANONICAL_HEAD, artifactSource: {headSha: EXPORTED_HEAD}});
  expect(f.calls.filter(call => call.url === API + "/git/matching-refs/tags/mentra-v")).toHaveLength(0);
  expect(f.calls.filter(call => call.url === API + "/git/commits/" + EXPORTED_HEAD)).toHaveLength(1);
  expect(f.calls.filter(call => call.url === CANONICAL_API + "/compare/" + EXPORTED_ORIGIN + "..." + CANONICAL_HEAD)).toHaveLength(1);
 }
});

test("canonical normal release keeps producer head and verified public artifact source without Actions artifacts", async () => {
 const f = canonicalFixture(), selected = await f.gateway.resolve(f.source, "android");
 expect(selected).toMatchObject({availability: "available", source: f.source, headSha: CANONICAL_HEAD,
  release: f.identity, artifactSource: {repository: REPO, headSha: EXPORTED_HEAD},
  archive: {sha256: f.asset.sha256, size: f.asset.size}});
 expect(selectedBuildInput(selected, "android")).toMatchObject({headSha: CANONICAL_HEAD,
  artifactSource: {repository: REPO, headSha: EXPORTED_HEAD}});
 expect(f.calls.some(call => /\/actions\/runs\/\d+\/artifacts/.test(call.url))).toBe(false);
 expect(f.calls.every(call => !call.init?.method || ["GET", "HEAD"].includes(call.init.method))).toBe(true);
});

test("canonical inventory and original-boundary discovery use the real normal workflow and finalizer", async () => {
 const f = canonicalFixture();
 expect(await f.gateway.inventory({repository: CANONICAL_REPO, channel: "dev", platform: "android"})).toMatchObject([
  {availability: "available", headSha: CANONICAL_HEAD, artifactSource: {headSha: EXPORTED_HEAD}}]);
 const selected = await new GithubTestBuildGateway({repository: CANONICAL_REPO, token: "test-only-token", fetch: f.fetch})
  .latestDev("android", "2026-10-25T11:00:00Z");
 expect(selected).toMatchObject({availability: "available", source: f.source, release: f.identity});
 expect(f.calls.some(call => call.url.includes("/actions/workflows/coordinated-release.yml"))).toBe(false);
 const ledgerReads = f.calls.filter(call => call.url === API + "/git/matching-refs/tags/mentra-v");
 expect(ledgerReads).toHaveLength(0);
});

test("canonical exact resolution has constant GitHub reads and never reads reservation history", async () => {
 const f = canonicalFixture();
 for (let n = 1; n <= 120; n++) {
  const identity = `3.4.0-dev.${2000 + n}`, name = `mentra-release-${identity}.json`;
  (f.rows.get(API + "/git/matching-refs/tags/mentra-v") as typeof f.releaseRef[]).push({...f.releaseRef, ref: "refs/tags/mentra-v" + identity});
  f.index.assets.push({...f.indexAsset, name, browser_download_url: CDN + "mentra-builds-v3.4.0/" + name,
   created_at: "2026-10-24T13:00:00Z"});
 }
 expect(await f.gateway.resolve(f.source, "android")).toMatchObject({availability: "available"});
 expect(f.calls.filter(call => call.url.startsWith("https://api.github.com/"))).toHaveLength(6);
 expect(f.calls.some(call => /mentra-sequence-|\/git\/tags\//.test(call.url))).toBe(false);
 expect(f.calls.filter(call => call.url.includes("mentra-release-") && call.url.endsWith(".json"))).toHaveLength(2);
});

test("canonical lookup derives its family from the actual declared version source at the producer SHA", async () => {
 const f = canonicalFixture(), definition = JSON.parse(readFileSync(new URL("../../../../../.github/release-family.json", import.meta.url), "utf8"));
 expect(definition.versionSource).toBe("package.json"); expect(definition.familyBaseVersion).toBeUndefined();
 expect(await f.gateway.resolve(f.source, "android")).toMatchObject({availability: "available", release: f.identity});
 expect(f.calls.filter(call => call.url === f.familyPath)).toHaveLength(1);
 expect(f.calls.filter(call => call.url === f.versionPath)).toHaveLength(1);
 const pathCount = f.calls.filter(call => call.url.includes("/contents/")).length;
 expect(pathCount).toBe(2);
 const declared = f.rows.get(f.familyPath) as {content: string; size: number};
 const bytes = JSON.stringify({...definition, versionSource: "../package.json"});
 declared.content = Buffer.from(bytes).toString("base64"); declared.size = Buffer.byteLength(bytes);
 await expect(f.gateway.resolve(f.source, "android")).rejects.toThrow();
 expect(f.calls.filter(call => call.url.includes("/contents/")).length).toBe(pathCount + 1);
});

test("canonical publication source and index remain fresh on every unscoped resolve", async () => {
 const f = canonicalFixture();
 expect(await f.gateway.resolve(f.source, "android")).toMatchObject({availability: "available"});
 f.asset.provenanceUrl = "https://github.com/" + CANONICAL_REPO + "/actions/runs/" + (f.id + 1); f.refreshIndex();
 await expect(f.gateway.forSelection("2026-10-25T12:00:00Z").resolve(f.source, "android"))
  .rejects.toThrow("Original canonical published release is not available");
 expect(f.calls.filter(call => call.url === f.indexUrl)).toHaveLength(2);
 expect(f.calls.filter(call => call.url === f.familyPath)).toHaveLength(2);
 expect(f.calls.filter(call => call.url === API + "/git/matching-refs/tags/mentra-v")).toHaveLength(0);
});

test("canonical manifest discovery cannot borrow a publication outside its producer window", async () => {
 for (const created_at of ["2026-10-24T13:36:59Z", "2026-10-24T14:39:01Z"]) {
  const f = canonicalFixture(); f.indexAsset.created_at = created_at;
  await expect(f.gateway.resolve(f.source, "android")).rejects.toThrow("Original canonical published release is not available");
  expect(f.calls.some(call => call.url === f.manifestUrl)).toBe(false);
 }
});

test("canonical index bytes and manifest claims never replace exact publication proof", async () => {
 for (const mutation of ["index-digest", "index-size", "index-repository", "index-url", "duplicate-index", "forged-provenance", "plan-digest", "family-path", "family-size"]) {
  const f = canonicalFixture();
  if (mutation === "index-digest") f.indexAsset.digest = "sha256:" + HASH;
  if (mutation === "index-size") f.indexAsset.size++;
  if (mutation === "index-repository") f.index.repository = CANONICAL_REPO;
  if (mutation === "index-url") f.indexAsset.browser_download_url = "https://foreign.invalid/manifest.json";
  if (mutation === "duplicate-index") f.index.assets.push({...f.indexAsset});
  if (mutation === "forged-provenance") {f.asset.provenanceUrl = "https://github.com/" + CANONICAL_REPO + "/actions/runs/" + (f.id + 1); f.refreshIndex();}
  if (mutation === "plan-digest") {f.manifest.releasePlanSha256 = HASH; f.refreshIndex();}
  if (mutation.startsWith("family-")) {
   const family = f.rows.get(f.familyPath) as {path: string; size: number};
   if (mutation === "family-path") family.path = "another/release-family.json";
   else family.size++;
  }
  if (mutation === "forged-provenance" || mutation === "index-repository" || mutation === "family-path")
   await expect(f.gateway.resolve(f.source, "android")).rejects.toThrow();
  else expect((await f.gateway.resolve(f.source, "android")).availability).toBe("unavailable");
 }
});

test("configured canonical discovery changes new selection only, leaving absent original provenance legacy", async () => {
 const f = canonicalFixture();
 const gateway = new GithubTestBuildGateway({repository: CANONICAL_REPO, token: "test-only-token", fetch: f.fetch});
 expect(await gateway.inventory({channel: "dev", platform: "android"})).toMatchObject([
  {availability: "available", source: {repository: CANONICAL_REPO}, headSha: CANONICAL_HEAD}]);
 expect(f.calls.some(call => call.url.startsWith(API + "/actions/workflows/"))).toBe(false);
 f.calls.length = 0;
 expect(await gateway.resolve({channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}, "ios-on-mac"))
  .toMatchObject({availability: "available", headSha: HEAD, source: {channel: "pr", prNumber: 12}});
 expect(f.calls.some(call => call.url.startsWith(CANONICAL_API + "/"))).toBe(false);
 expect(await gateway.inventory({repository: REPO, channel: "pr", pr: 12, platform: "ios-on-mac"})).toEqual([]);
});

test("canonical Mac release verifies the public app source while retaining canonical ownership", async () => {
 const f = canonicalFixture(), otaUrl = CDN + "mentra-builds-v3.4.0/" + f.plan.artifactNames.otaManifest;
 const archive = {name: "mentraos-" + f.identity + "-mac.zip", sha256: HASH, size: 100};
 const receipt = {schemaVersion: 1, releaseIdentity: f.identity, sourceCommit: EXPORTED_HEAD,
  app: {bundleId: "com.mentra.mentra", headSha: EXPORTED_HEAD, backend: "dev", build: String(f.plan.native.buildNumber),
   version: f.plan.native.marketingVersion, otaManifestUrl: otaUrl, executableSha256: HASH, javascriptSha256: HASH},
  artifacts: {mac: archive}};
 f.rows.set(CDN + "mentra-builds-v3.4.0/mentraos-" + f.identity + "-apple-downloads.json", receipt);
 f.rows.set("HEAD " + CDN + "mentra-builds-v3.4.0/" + archive.name, new Response(null, {headers: {"Content-Length": "100"}}));
 expect(await f.gateway.resolve(f.source, "ios-on-mac")).toMatchObject({availability: "available",
  headSha: CANONICAL_HEAD, artifactSource: {headSha: EXPORTED_HEAD}, app: {executableSha256: HASH}});
 receipt.app.headSha = CANONICAL_HEAD;
 expect((await f.gateway.resolve(f.source, "ios-on-mac")).availability).toBe("unavailable");
 receipt.app.headSha = EXPORTED_HEAD; receipt.sourceCommit = CANONICAL_HEAD;
 expect((await f.gateway.resolve(f.source, "ios-on-mac")).availability).toBe("unavailable");
});

test("canonical Mac selection requires the common finalized manifest's exact run ownership", async () => {
 const f = canonicalFixture();
 f.asset.provenanceUrl = "https://github.com/" + REPO + "/actions/runs/" + f.id; f.refreshIndex();
 await expect(f.gateway.resolve(f.source, "ios-on-mac")).rejects.toThrow("Original canonical published release is not available");
 expect(f.calls.some(call => call.url.endsWith("-apple-downloads.json"))).toBe(false);
});

test("canonical staging producer selects only its original beta identity and public export", async () => {
 const f = canonicalFixture(), beta = "3.4.0-beta.1097";
 for (const [key, value] of [...f.rows]) {
  const nextKey = key.replaceAll(f.identity, beta);
  if (value instanceof Response) f.rows.set(nextKey, value);
  else {
   const row = JSON.parse(JSON.stringify(value).replaceAll(f.identity, beta));
   if (key.endsWith("/attempts/1")) row.head_branch = "staging";
   if (key === f.planUrl || key === f.manifestUrl) row.channel = "beta";
   f.rows.set(nextKey, row);
  }
 }
 const planUrl = f.planUrl.replace(f.identity, beta), manifestUrl = f.manifestUrl.replace(f.identity, beta);
 const plan = f.rows.get(planUrl);
 const manifest = f.rows.get(manifestUrl) as {releasePlanSha256: string};
 manifest.releasePlanSha256 = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
 const index = f.rows.get(f.indexUrl) as typeof f.index; const bytes = JSON.stringify(manifest);
 index.assets[0]!.size = Buffer.byteLength(bytes); index.assets[0]!.digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
 expect(await f.gateway.resolve({...f.source, channel: "staging"}, "android")).toMatchObject({availability: "available",
  headSha: CANONICAL_HEAD, release: beta, artifactSource: {headSha: EXPORTED_HEAD}});
});

test("canonical resolver accepts the captured two-commit private-only source projection", async () => {
 const f = canonicalFixture();
 f.compare.total_commits = 2;
 f.compare.commits = [{sha: "5707638d948be8c7260e930ea201990700219a32"}, {sha: CANONICAL_HEAD}];
 f.compare.files = ["testing/framework/cleanup.ts", "testing/framework/platforms/mac-controller.ts",
  "testing/framework/platforms/mac-prebaseline-installed-repair.test.ts", "testing/framework/platforms/mac.ts",
  "testing/framework/platforms/provider.ts", "testing/host/deployment/retained-phone-source.test.ts",
  "testing/host/deployment/retained-source-dependencies.ts", "testing/orchestration/authoring.ts",
  "testing/orchestration/fixer/passive-return.test.ts", "testing/orchestration/fixer/provider.ts"].map(filename => ({filename}));
 expect(await f.gateway.resolve(f.source, "android")).toMatchObject({availability: "available",
  headSha: CANONICAL_HEAD, artifactSource: {headSha: EXPORTED_HEAD}});
});

test("canonical finalized manifests require one exact run owner and completed public export", async () => {
 for (const mutation of ["owner", "duplicate-owner", "identity", "source", "origin", "duplicate-origin"]) {
  const f = canonicalFixture();
  if (mutation === "owner") {f.asset.provenanceUrl = "https://github.com/" + REPO + "/actions/runs/" + f.id; f.refreshIndex();}
  if (mutation === "duplicate-owner") {
   const identity = "3.4.0-dev.1098", name = "mentra-release-" + identity + ".json";
   const manifest = {...f.manifest, releaseIdentity: identity, artifacts: [{...f.asset, coordinate: "mentraos-" + identity + "-android.apk"}]};
   const bytes = JSON.stringify(manifest), url = CDN + "mentra-builds-v3.4.0/" + name;
   f.rows.set(url, manifest); f.index.assets.push({...f.indexAsset, name, browser_download_url: url,
    size: Buffer.byteLength(bytes), digest: "sha256:" + createHash("sha256").update(bytes).digest("hex")});
   f.rows.set(API + "/git/matching-refs/tags/mentra-v", [f.releaseRef, {...f.releaseRef, ref: "refs/tags/mentra-v" + identity}]);
  }
  if (mutation === "identity") {f.manifest.releaseIdentity = "3.4.0-dev.1098"; f.refreshIndex();}
  if (mutation === "source") {f.manifest.sourceCommit = HEAD; f.refreshIndex();}
  if (mutation === "origin") f.rows.set(API + "/git/commits/" + EXPORTED_HEAD, {sha: EXPORTED_HEAD, message: "Export without origin"});
  if (mutation === "duplicate-origin") f.rows.set(API + "/git/commits/" + EXPORTED_HEAD, {sha: EXPORTED_HEAD,
   message: "GitOrigin-RevId: " + EXPORTED_ORIGIN + "\nGitOrigin-RevId: " + CANONICAL_HEAD});
  if (["owner", "source"].includes(mutation)) await expect(f.gateway.resolve(f.source, "android")).rejects.toMatchObject({status: 502});
  else expect((await f.gateway.resolve(f.source, "android")).availability).toBe("unavailable");
 }
});

test("canonical public projection rejects changed export paths, renames, foreign origin and truncated comparisons", async () => {
 for (const mutation of ["path", "miniapp", "renamed", "base", "merge", "head", "diverged", "duplicates", "commits", "files"]) {
  const f = canonicalFixture();
  if (mutation === "path") f.compare.files = [{filename: "public/mentraos/mobile/app.config.ts"}];
  if (mutation === "miniapp") f.compare.files = [{filename: "miniapps/public/recorder/server/index.ts"}];
  if (mutation === "renamed") f.rows.set(CANONICAL_API + "/compare/" + EXPORTED_ORIGIN + "..." + CANONICAL_HEAD,
   {...f.compare, files: [{filename: "private/archive.ts", previous_filename: "public/mentraos/mobile/app.config.ts"}]});
  if (mutation === "base") f.compare.base_commit.sha = BASE;
  if (mutation === "merge") f.compare.merge_base_commit.sha = BASE;
  if (mutation === "head") f.compare.commits = [{sha: HEAD}];
  if (mutation === "diverged") f.compare.status = "diverged";
  if (mutation === "duplicates") {f.compare.total_commits = 2; f.compare.commits = [{sha: CANONICAL_HEAD}, {sha: CANONICAL_HEAD}];}
  if (mutation === "commits") f.compare.total_commits = 251;
  if (mutation === "files") f.compare.files = Array.from({length: 300}, (_, n) => ({filename: "private/" + n}));
  if (["commits", "files"].includes(mutation)) await expect(f.gateway.resolve(f.source, "android")).rejects.toMatchObject({status: 502});
  else expect((await f.gateway.resolve(f.source, "android")).availability).toBe("unavailable");
 }
});

test("canonical published bytes retain exact source, run provenance, plan digest, native identity and HEAD size", async () => {
 for (const mutation of ["plan-source", "receipt-source", "digest", "native", "provenance", "url", "size", "ota"]) {
  const f = canonicalFixture();
  if (mutation === "plan-source") f.plan.sourceCommit = CANONICAL_HEAD;
  if (mutation === "receipt-source") f.manifest.sourceCommit = CANONICAL_HEAD;
  if (mutation === "digest") f.manifest.releasePlanSha256 = HASH;
  if (mutation === "native") f.manifest.native = {...f.manifest.native, buildNumber: 304000084};
  if (mutation === "provenance") f.asset.provenanceUrl = "https://github.com/" + REPO + "/actions/runs/" + f.id;
  if (mutation === "url") f.asset.url = "https://other.invalid/" + f.plan.artifactNames.androidApp;
  if (mutation === "size") f.rows.set("HEAD " + f.asset.url, new Response(null, {headers: {"Content-Length": "1"}}));
  if (mutation === "ota") f.rows.set(CDN + "mentra-builds-v3.4.0/" + f.plan.artifactNames.otaManifest, {releaseVersion: "3.4.0-dev.1098"});
  const selected = await f.gateway.resolve(f.source, "android");
  expect(selected.availability).toBe("unavailable"); expect(selected.artifactSource).toBeUndefined();
 }
});

test("canonical attempts and finalizers cannot borrow another execution or fall back past a later failure", async () => {
 for (const mutation of ["attempt", "workflow", "foreign", "incomplete", "duplicate", "later-failure"]) {
  const f = canonicalFixture();
  if (mutation === "attempt") f.producer.run_attempt = 2;
  if (mutation === "workflow") f.producer.path = ".github/workflows/coordinated-release.yml";
  if (mutation === "foreign") f.producer.head_repository.full_name = REPO;
  if (mutation === "incomplete") f.job.status = "in_progress";
  if (mutation === "duplicate") f.rows.set(CANONICAL_API + "/actions/runs/" + f.id + "/jobs?filter=all&per_page=100&page=1",
   {total_count: 2, jobs: [f.job, {...f.job, id: f.job.id + 1}]});
  if (mutation === "later-failure") {
   f.producer.run_attempt = 2;
   f.rows.set(CANONICAL_API + "/actions/runs/" + f.id + "/attempts/2", f.producer);
   f.rows.set(CANONICAL_API + "/actions/runs/" + f.id + "/jobs?filter=all&per_page=100&page=1",
    {total_count: 2, jobs: [f.job, {...f.job, id: f.job.id + 1, run_attempt: 2, conclusion: "failure"}]});
  }
  if (["attempt", "workflow", "foreign"].includes(mutation)) await expect(f.gateway.resolve(f.source, "android")).rejects.toThrow("selected source and publication attempt");
  else expect((await f.gateway.resolve({...f.source, publicationAttempt: mutation === "later-failure" ? 2 : 1}, "android")).availability).toBe("unavailable");
 }
});

test("canonical publication discovery failures remain bounded provider waits", async () => {
 for (const mutation of ["missing-manifest", "provider", "hidden-index", "missing-index-entry"]) {
  const f = canonicalFixture();
  if (mutation === "missing-manifest") f.rows.delete(f.manifestUrl);
  if (mutation === "provider") f.rows.set(f.indexUrl, new Response("private provider detail", {status: 503}));
  if (mutation === "hidden-index") f.rows.delete(f.indexUrl);
  if (mutation === "missing-index-entry") f.index.assets = [];
  await expect(f.gateway.resolve(f.source, "android")).rejects.toMatchObject({status: 502});
  expect(f.calls.filter(call => call.url.includes("/attempts/"))).toHaveLength(1);
 }
});

test("canonical normal reads use independent App repository authorities for producer and public ledger", async () => {
 const f = canonicalFixture(), grants: string[] = [];
 const appAuth = {async token(scope: string, repository?: string) {grants.push(scope + ":" + repository); return "fixture-" + repository;}} as any;
 const gateway = new GithubTestBuildGateway({appAuth, fetch: f.fetch});
 expect((await gateway.resolve(f.source, "android")).availability).toBe("available");
 expect(grants).toContain("source:" + CANONICAL_REPO); expect(grants).toContain("source:" + REPO);
 for (const call of f.calls.filter(call => call.url.startsWith("https://api.github.com/"))) {
  const repository = call.url.startsWith(CANONICAL_API + "/") ? CANONICAL_REPO : REPO;
  expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer fixture-" + repository);
 }
});
function nightlyFixture() {
 const f = fixture();
 const identity = "3.2.1-dev.20", tag = "mentra-builds-v3.2.1";
 f.rows.set(`${API}/actions/runs/60/jobs?filter=all&per_page=100&page=1`, {total_count: 0, jobs: []});
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [finalizer]});
 f.rows.set(`${API}/actions/runs/50/artifacts?per_page=100`, {artifacts: [{name: `coordinated-release-plan-mentra-${identity}`,
  expired: false, workflow_run: {id: 50, head_sha: HEAD}}, {name: `coordinated-release-result-mentra-${identity}`,
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

function coordinatedFixture() {
 const f = nightlyFixture(), identity = "3.2.1-dev.20", tag = "mentra-builds-v3.2.1";
 const plan = f.rows.get(f.planUrl) as {native: {buildNumber: number; marketingVersion: string}; artifactNames: Record<string, string>};
 plan.artifactNames.androidApp = `mentraos-${identity}-android.apk`;
 plan.artifactNames.releaseManifest = `mentra-release-${identity}.json`;
 f.rows.set(`${API}/actions/runs/50/attempts/1`, releaseRun());
 f.rows.set(`${CDN}${tag}/${plan.artifactNames.releaseManifest}`, {schemaVersion: 1, releaseIdentity: identity, releaseSetId: `mentra-${identity}`,
  sourceCommit: HEAD, releasePlanSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"), channel: "dev", native: plan.native,
  artifacts: [{coordinate: plan.artifactNames.androidApp, url: `${CDN}${tag}/${plan.artifactNames.androidApp}`, sha256: HASH, size: 100, status: "published"}]});
 f.rows.set(`HEAD ${CDN}${tag}/${plan.artifactNames.androidApp}`, new Response(null, {headers: {"Content-Length": "100"}}));
 return {...f, identity, tag, source: {channel: "dev" as const, buildRunId: 50, publicationAttempt: 1}};
}

test("coordinated Android publication retains source-bound manifest URL, size and digest", async () => {
 const f = coordinatedFixture(), {identity, tag} = f;
 const selected = await f.gateway.resolve({channel: "dev", buildRunId: 50, publicationAttempt: 1}, "android");
 const bytes = JSON.stringify({releaseVersion: identity});
 expect(selected).toMatchObject({availability: "available", release: identity, manifest: {url: `${CDN}${tag}/mentra-live-ota-${identity}.json`,
  sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes)}});
 expect(selected.manifestSha256).toBe(selected.manifest!.sha256);
});


test("successful coordinated finalizers with omitted steps still require exact immutable Android and Mac publication", async () => {
 for (const stepMetadata of [{steps: []}, {}]) {
  const f = coordinatedFixture();
  const {steps, ...withoutSteps} = finalizer;
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1,
   jobs: [{...withoutSteps, ...stepMetadata}]});
  for (const platform of ["android", "ios-on-mac"] as const) {
   expect(await f.gateway.resolve(f.source, platform)).toMatchObject({availability: "available", release: f.identity,
    source: f.source, headSha: HEAD, archive: {sha256: HASH, size: 100}});
   expect(await f.gateway.latestDev(platform, before)).toMatchObject({availability: "available", release: f.identity, source: f.source});
  }
  expect(f.calls.every(call => !call.init?.method || ["GET", "HEAD"].includes(call.init.method))).toBe(true);
 }
});

test("omitted finalizer steps never admit unsuccessful, incomplete or ambiguous finalizers", async () => {
 for (const rows of [[], [{...finalizer, steps: [], status: "in_progress", conclusion: null}],
  [{...finalizer, steps: [], conclusion: "failure"}], [{...finalizer, steps: []}, {...finalizer, id: 71, steps: []}]]) {
  const f = coordinatedFixture();
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: rows.length, jobs: rows});
  for (const platform of ["android", "ios-on-mac"] as const) {
   expect(await f.gateway.resolve(f.source, platform)).toMatchObject({availability: "unavailable",
    reason: "Selected coordinated attempt did not publish immutable assets"});
  }
 }
});

test("successful finalizers without readable immutable platform receipts remain unavailable", async () => {
 for (const platform of ["android", "ios-on-mac"] as const) {
  const f = coordinatedFixture();
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [{...finalizer, steps: []}]});
  const receipt = platform === "android" ? `mentra-release-${f.identity}.json` : `mentraos-${f.identity}-apple-downloads.json`;
  f.rows.delete(`${CDN}${f.tag}/${receipt}`);
  await expect(f.gateway.resolve(f.source, platform)).rejects.toThrow("Build metadata unavailable (HTTP 404)");
  await expect(f.gateway.latestDev(platform, before)).rejects.toThrow("Build metadata unavailable (HTTP 404)");
 }
});

test("a successful unpublished dry run cannot displace an older real nightly publication", async () => {
 const f = coordinatedFixture();
 const dry = releaseRun({id: 60, event: "workflow_dispatch", created_at: "2026-09-23T02:00:00Z"});
 f.rows.set(nightlyUrl, {total_count: 2, workflow_runs: [dry, releaseRun()]});
 f.rows.set(`${API}/actions/runs/60/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [{...finalizer, id: 71, steps: []}]});
 f.rows.set(`${API}/actions/runs/60/artifacts?per_page=100`, {artifacts: [{name: "coordinated-release-plan-mentra-3.2.1-dev.21",
  expired: false, workflow_run: {id: 60, head_sha: HEAD}}]});
 f.rows.set(`${API}/actions/runs/60/attempts/1`, dry);
 for (const platform of ["android", "ios-on-mac"] as const) {
  expect(await f.gateway.latestDev(platform, before)).toMatchObject({availability: "available", source: f.source});
  expect(await f.gateway.resolve({channel: "dev", buildRunId: 60, publicationAttempt: 1}, platform)).toMatchObject({availability: "unavailable"});
 }
 expect(f.calls.some(call => call.url.includes("mentra-release-plan-3.2.1-dev.21.json"))).toBe(false);
});

test("expired, ambiguous or source-mismatched finalized results never select an older release", async () => {
 for (const mismatch of ["expired", "name", "source", "run", "duplicate"]) {
  const f = coordinatedFixture();
  const result = {name: `coordinated-release-result-mentra-${f.identity}`, expired: false, workflow_run: {id: 50, head_sha: HEAD}};
  if (mismatch === "expired") result.expired = true;
  if (mismatch === "name") result.name = "coordinated-release-result-mentra-3.2.1-dev.21";
  if (mismatch === "source") result.workflow_run.head_sha = BASE;
  if (mismatch === "run") result.workflow_run.id = 99;
  const listing = f.rows.get(`${API}/actions/runs/50/artifacts?per_page=100`) as {artifacts: unknown[]};
  listing.artifacts = [listing.artifacts[0], result, ...(mismatch === "duplicate" ? [result] : [])];
  for (const platform of ["android", "ios-on-mac"] as const) {
   await expect(f.gateway.latestDev(platform, before)).rejects.toThrow("Finalized release result is missing or ambiguous");
   expect(await f.gateway.resolve(f.source, platform)).toMatchObject({availability: "unavailable", reason: "Finalized release result is missing or ambiguous"});
  }
 }
});

test("omitted finalizer steps cannot bypass source, plan digest, native identity or archive length checks", async () => {
 for (const mismatch of ["plan-source", "plan-digest", "android-native", "mac-source", "android-size", "mac-size"]) {
  const f = coordinatedFixture();
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count: 1, jobs: [{...finalizer, steps: []}]});
  const androidUrl = `${CDN}${f.tag}/mentra-release-${f.identity}.json`;
  const macUrl = `${CDN}${f.tag}/mentraos-${f.identity}-apple-downloads.json`;
  if (mismatch === "plan-source") (f.rows.get(f.planUrl) as {sourceCommit: string}).sourceCommit = BASE;
  if (mismatch === "plan-digest") (f.rows.get(androidUrl) as {releasePlanSha256: string}).releasePlanSha256 = "e".repeat(64);
  if (mismatch === "android-native") {
   const receipt = f.rows.get(androidUrl) as {native: {buildNumber: number; marketingVersion: string}};
   receipt.native = {...receipt.native, buildNumber: 99};
  }
  if (mismatch === "mac-source") (f.rows.get(macUrl) as {sourceCommit: string}).sourceCommit = BASE;
  const platform = mismatch.startsWith("mac") ? "ios-on-mac" : "android";
  if (mismatch.endsWith("size")) {
   const name = platform === "android" ? `mentraos-${f.identity}-android.apk` : f.archive.name;
   f.rows.set(`HEAD ${CDN}${f.tag}/${name}`, new Response(null, {headers: {"Content-Length": "99"}}));
  }
  expect((await f.gateway.resolve(f.source, platform)).availability).toBe("unavailable");
 }
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

test('PR supersession requires authenticated changed head; unavailable metadata does not cancel', async () => {
  const f = fixture();
  expect(await f.gateway.isPrSuperseded(12, HEAD)).toBe(false);
  f.rows.set(`${API}/pulls/12`, {...pr, head: {...pr.head, sha: 'f'.repeat(40)}});
  expect(await f.gateway.isPrSuperseded(12, HEAD)).toBe(true);
  f.rows.set(`${API}/pulls/12`, new Response('unavailable', {status: 503}));
  await expect(f.gateway.isPrSuperseded(12, HEAD)).rejects.toThrow('metadata unavailable');
});

test('retained trusted producer run resolves directly when it is absent from recent lists', async () => {
 const f = fixture(), producer = run({event: 'workflow_dispatch', head_branch: 'dev', head_sha: BASE,
  display_title: `Routine PR #12 ${HEAD} dev ${'e'.repeat(64)}`});
 f.rows.set(`${API}/actions/runs/50`, producer);
 const values = await f.gateway.inventory({channel: 'pr', pr: 12, platform: 'ios-on-mac'}, true, 50);
 expect(values).toHaveLength(1); expect(values[0]!.availability).toBe('available');
 expect(f.calls.some(call => call.url === `${API}/actions/runs/50`)).toBe(true);
});

test('diagnostic signed publication is explicit authoring selection and cannot become ordinary inventory', async () => {
 const f = fixture(), name = `mentra-android-nimo-diagnostic-pr-12-${HEAD}-50-1`;
 f.rows.set(`${API}/actions/runs/50/attempts/1`, run({path: '.github/workflows/mentra-app-android-build.yml', event: 'workflow_dispatch', head_branch: 'dev',
   display_title: `Routine PR #12 ${HEAD} dev`}));
 f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, {total_count:1,jobs:[{...jobs[0]!, steps:[{name:'Upload APK to the public artifact CDN', status:'completed', conclusion:'success'}]}]});
 const receipt = {schemaVersion:1,diagnostic:'nimo-resource-v1',diagnosticVerification:{kind:'compiled-capture-wiring-v3',clockProtocol:'nimo-monotonic-receipt-v1',captureProtocol:'nimo-preconnect-capture-v1',captureRequiredBeforeArm:true,scanInstancePreserved:true,apkSha256:HASH,wiringSha256:HASH,analyzer:{source:'android-sdk-command-line-tools',revision:'19.0',sha256:HASH}},pr:12,headSha:HEAD,baseSha:BASE,buildSha:MERGE,runId:50,runAttempt:1,
   app:{packageId:'com.mentra.mentra',version:'3.4.0',build:'42',headSha:HEAD,buildSha:MERGE,backend:'dev', diagnostic:'nimo-resource-v1',otaManifestUrl:`${CDN}pr-builds/ota-pr-12-${HEAD}.json`},
   artifacts:{android:{name:`${name}.apk`,sha256:HASH,size:100}}};
 f.rows.set(`${CDN}pr-builds/${name}.json`,receipt);
 f.rows.set(`HEAD ${CDN}pr-builds/${name}.apk`,new Response(null,{headers:{'Content-Length':'100'}}));
 const source = {channel:'pr' as const,prNumber:12,buildRunId:50,publicationAttempt:1};
 expect(await f.gateway.resolveNimoDiagnostic(source)).toMatchObject({availability:'available',diagnostic:'nimo-resource-v1'});
 for (const proof of [
   {...receipt.diagnosticVerification,kind:'compiled-receiver-wiring-v1'},
   {...receipt.diagnosticVerification,kind:'compiled-capture-wiring-v2'},
   {...receipt.diagnosticVerification,clockProtocol:undefined},
   {...receipt.diagnosticVerification,clockProtocol:'epoch-v1'},
   {...receipt.diagnosticVerification,captureProtocol:undefined},
    {...receipt.diagnosticVerification,captureRequiredBeforeArm:undefined},
    {...receipt.diagnosticVerification,captureRequiredBeforeArm:false},
   {...receipt.diagnosticVerification,scanInstancePreserved:undefined},
   {...receipt.diagnosticVerification,scanInstancePreserved:false},
   {...receipt.diagnosticVerification,captureProtocol:'other-capture-v1'},
 ]) {
   f.rows.set(`${CDN}pr-builds/${name}.json`,{...receipt,diagnosticVerification:proof});
   await expect(f.gateway.resolveNimoDiagnostic(source)).rejects.toThrow();
 }
 f.rows.set(`${CDN}pr-builds/${name}.json`,{...receipt,diagnosticVerification:undefined});
 await expect(f.gateway.resolveNimoDiagnostic(source)).rejects.toThrow();
 f.rows.set(`${CDN}pr-builds/${name}.json`,{...receipt,diagnosticVerification:{...receipt.diagnosticVerification,apkSha256:'e'.repeat(64)}});
 expect(await f.gateway.resolveNimoDiagnostic(source)).toMatchObject({availability:'unavailable',reason:'Diagnostic wiring proof belongs to another APK'});
 f.rows.set(`${CDN}pr-builds/${name}.json`,receipt);
 // A diagnostic marker is rejected even if maliciously published under ordinary coordinates.
 f.rows.set(`${CDN}pr-builds/mentra-android-pr-12-${HEAD}-50-1.json`,receipt);
 expect(await f.gateway.resolve(source,'android')).toMatchObject({availability:'unavailable',reason:'Diagnostic APK cannot enter ordinary build selection'});
 await expect(f.gateway.resolveNimoDiagnostic({channel:'dev',buildRunId:50,publicationAttempt:1})).rejects.toThrow('exact PR');
 const {selectedBuildInput} = await import('../types/test-build.types');
 const build = await f.gateway.resolveNimoDiagnostic(source);
 expect(() => selectedBuildInput(build,'android')).toThrow('explicit NIMO authoring');
 expect(selectedBuildInput(build,'android',true)).toMatchObject({diagnostic:'nimo-resource-v1'});
});

test("one nightly selection reuses authenticated run reads for both platform artifacts", async () => {
 const f = coordinatedFixture(), scoped = f.gateway.forSelection(before);
 const selected = await scoped.latestDev("android", before);
 expect(selected?.availability).toBe("available");
 expect(await scoped.resolve(selected!.source, "ios-on-mac")).toMatchObject({availability: "available", source: f.source});
 const count = (url: string) => f.calls.filter(call => call.url === url).length;
 expect(count(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`)).toBe(1);
 expect(count(`${API}/actions/runs/50/artifacts?per_page=100`)).toBe(1);
 expect(count(f.planUrl)).toBe(1);
 expect(count(`${CDN}${f.tag}/mentra-live-ota-${f.identity}.json`)).toBe(1);
 // Resolving the other platform still authenticates the exact selected attempt and its archive.
 expect(count(`${API}/actions/runs/50/attempts/1`)).toBe(1);
 expect(f.calls.filter(call => call.init?.method === "HEAD")).toHaveLength(2);
 expect(f.calls.filter(call => call.url.startsWith(API))).toHaveLength(5);
});

test("same-run concurrent resolution shares in-flight reads without sharing current PR authority", async () => {
 const f = coordinatedFixture(), jobsUrl = `${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`;
 let unblock!: () => void;
 const blocked = new Promise<void>(resolve => {unblock = resolve;});
 let began!: () => void;
 const started = new Promise<void>(resolve => {began = resolve;});
 const fetch = (async (url: string, init?: RequestInit) => {
  if (url === jobsUrl) {began(); await blocked;}
  return f.fetch(url, init);
 }) as typeof globalThis.fetch;
 const scoped = new GithubTestBuildGateway({token: "test-only-token", fetch}).forSelection(before);
 const pending = Promise.all([scoped.resolve(f.source, "android"), scoped.resolve(f.source, "ios-on-mac")]);
 await started;
 unblock();
 expect((await pending).every(build => build.availability === "available")).toBe(true);
 expect(f.calls.filter(call => call.url === jobsUrl)).toHaveLength(1);
 expect(f.calls.filter(call => call.url === `${API}/actions/runs/50/artifacts?per_page=100`)).toHaveLength(1);
 expect(f.calls.filter(call => call.url === f.planUrl)).toHaveLength(1);
 expect(f.calls.filter(call => call.url === `${API}/actions/runs/50/attempts/1`)).toHaveLength(2);
 const p = fixture(), prScope = p.gateway.forSelection(before);
 expect(await prScope.isPrSuperseded(12, HEAD)).toBe(false);
 p.rows.set(`${API}/pulls/12`, {...pr, head: {...pr.head, sha: BASE}});
 expect(await prScope.isPrSuperseded(12, HEAD)).toBe(true);
 expect(p.calls.filter(call => call.url === `${API}/pulls/12`)).toHaveLength(2);
});

test("selection reuse does not retain authority across occurrences or hide missing and changed publications", async () => {
 const f = coordinatedFixture();
 const originalScope = f.gateway.forSelection(before);
 expect((await originalScope.latestDev("android", before))?.availability).toBe("available");
 await expect(originalScope.latestDev("android", "2026-09-23T12:00:00Z")).rejects.toThrow("Selection changed its original build boundary");
 const jobsUrl = `${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`;
 f.rows.set(jobsUrl, new Response("rate exhausted", {status: 403}));
 await expect(f.gateway.latestDev("android", before)).rejects.toThrow("Build metadata unavailable (HTTP 403)");
 expect(f.calls.filter(call => call.url === jobsUrl)).toHaveLength(2);
 for (const mutation of ["attempt", "head", "missing", "ambiguous", "archive"]) {
  const p = coordinatedFixture(), scope = p.gateway.forSelection(before);
  expect((await scope.latestDev("android", before))?.availability).toBe("available");
  if (mutation === "attempt") p.rows.set(`${API}/actions/runs/50/attempts/1`, releaseRun({run_attempt: 2}));
  if (mutation === "head") p.rows.set(`${API}/actions/runs/50/attempts/1`, releaseRun({head_sha: BASE}));
  if (mutation === "missing") p.rows.delete(`${CDN}${p.tag}/mentraos-${p.identity}-apple-downloads.json`);
  if (mutation === "archive") p.rows.set(`HEAD ${CDN}${p.tag}/${p.archive.name}`, new Response(null, {headers: {"Content-Length": "99"}}));
  if (mutation === "ambiguous") {
   const artifacts = p.rows.get(`${API}/actions/runs/50/artifacts?per_page=100`) as {artifacts: unknown[]};
   artifacts.artifacts.push(artifacts.artifacts[1]);
   // A new selection must re-read the mutable artifact listing and refuse its ambiguity.
   await expect(p.gateway.latestDev("android", before)).rejects.toThrow("Finalized release result is missing or ambiguous");
   continue;
  }
  if (mutation === "attempt") await expect(scope.resolve(p.source, "ios-on-mac")).rejects.toThrow("selected source and publication attempt");
  else if (mutation === "missing") await expect(scope.resolve(p.source, "ios-on-mac")).rejects.toThrow("Build metadata unavailable (HTTP 404)");
  else expect((await scope.resolve(p.source, "ios-on-mac")).availability).toBe("unavailable");
 }
});


test("build denial logging retains only its endpoint, consumer and parsed rate headers", async () => {
 const f = canonicalFixture(), reports: Array<Record<string, unknown>> = [];
 f.rows.set(CANONICAL_API + "/actions/runs/" + f.id + "/attempts/1", new Response("secret-provider-body", {status: 403,
  headers: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793066874", "x-ratelimit-limit": "5000",
   "x-ratelimit-used": "5000", "x-ratelimit-resource": "core", "x-github-request-id": "1234:ABCD:5678:EF90"}}));
 const gateway = new GithubTestBuildGateway({token: "secret-token", fetch: f.fetch, report: value => reports.push(value)});
 await expect(gateway.resolve(f.source, "android")).rejects.toMatchObject({status: 503});
 expect(reports).toEqual([{consumer: "test-build-selection", endpoint: "/repos/" + CANONICAL_REPO + "/actions/runs/" + f.id + "/attempts/1",
  method: "GET", status: 403, githubRequestId: "1234:ABCD:5678:EF90",
  rateLimit: {limit: 5000, remaining: 0, reset: 1793066874, used: 5000, resource: "core"}}]);
 expect(JSON.stringify(reports)).not.toContain("secret");
 f.rows.set(CANONICAL_API + "/actions/runs/" + f.id + "/attempts/1", new Response("secret-provider-body", {status: 503,
  headers: {"x-ratelimit-remaining": "secret-token", "x-github-request-id": "secret-provider-body", "retry-after": "secret-token"}}));
 await expect(gateway.resolve(f.source, "android")).rejects.toMatchObject({status: 502});
 expect(reports[1]).toEqual({consumer: "test-build-selection", endpoint: reports[0]!.endpoint, method: "GET", status: 503});
});

test("GitHub quota failures explain the proven limit and retain generic refusals otherwise", async () => {
 for (const status of [403, 429]) {
  const f = coordinatedFixture();
  f.rows.set(nightlyUrl, new Response("private provider body", {status, headers: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792771146"}}));
  await expect(f.gateway.latestDev("android", before)).rejects.toMatchObject({status: 503,
   message: "Build information is unavailable because GitHub's request limit was reached. The limit resets at 2026-10-23T15:59:06.000Z."});
 }
 for (const headers of [{}, {"x-ratelimit-remaining": "1", "x-ratelimit-reset": "1792771146"},
  {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "not-a-time"}, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "999999999999999999"}] as Record<string, string>[]) {
  const f = coordinatedFixture();
  f.rows.set(nightlyUrl, new Response("private provider body", {status: 403, headers}));
  await expect(f.gateway.latestDev("android", before)).rejects.toMatchObject({status: 502, message: "Build metadata unavailable (HTTP 403)"});
 }
 const f = coordinatedFixture();
 f.rows.set(f.planUrl, new Response("private CDN body", {status: 403, headers: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792771146"}}));
 await expect(f.gateway.latestDev("android", before)).rejects.toMatchObject({status: 502, message: "Build metadata unavailable (HTTP 403)"});
});


test("Mentra app artifacts resolve from the pinned repository while retained MentraOS selections stay unchanged", async () => {
 const f = fixture(), repository = "Mentra-Community/Mentra", currentApi = `https://api.github.com/repos/${repository}`;
 for (const [key, value] of [...f.rows]) if (key.startsWith(API)) {
  let row = value;
  if (key.endsWith("/pulls/12")) row = {...pr, head: {...pr.head, repo: {full_name: repository}}};
  if (key.includes("/actions/runs/50/attempts/1")) row = run({repository: {full_name: repository}, head_repository: {full_name: repository}});
  f.rows.set(key.replace(API, currentApi), row);
 }
 const currentRun = run({repository: {full_name: repository}, head_repository: {full_name: repository}});
 f.rows.set(`${currentApi}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100&page=1`, {workflow_runs: [currentRun]});
 const legacy = {channel: "pr" as const, prNumber: 12, buildRunId: 50, publicationAttempt: 1};
 const original = await f.gateway.resolve(legacy, "ios-on-mac");
 const selected = await f.gateway.resolve({...legacy, repository}, "ios-on-mac");
 expect(selected.availability).toBe("available"); expect(selected.source.repository).toBe(repository);
 expect(selected.buildUrl).toBe(`https://github.com/${repository}/actions/runs/50`);
 expect(selectedBuildInput(selected, "ios-on-mac").repository).toBe(repository);
 expect(selected.archive).toEqual(original.archive);
 expect((await f.gateway.inventory({channel: "pr", pr: 12, platform: "ios-on-mac", repository}))[0]!.source.repository).toBe(repository);
 const canonicalReads = f.calls.filter(call => call.url.startsWith(currentApi));
 expect(canonicalReads.some(call => call.url.endsWith(`/commits/${MERGE}`))).toBe(true);
 expect(canonicalReads.some(call => call.url.endsWith("/jobs?filter=all&per_page=100&page=1"))).toBe(true);
 expect(await f.gateway.resolve(legacy, "ios-on-mac")).toEqual(original);
 expect((await f.gateway.resolve({...legacy, repository: REPO}, "ios-on-mac")).source.repository).toBe(REPO);
 f.rows.set(`${currentApi}/actions/runs/50/attempts/1`, run());
 await expect(f.gateway.resolve({...legacy, repository}, "ios-on-mac")).rejects.toThrow("selected source and publication attempt");
 for (const wrong of ["other/Mentra", "Mentra-Community/Mentra-Automated-Testing"]) {
  const source = {...legacy, repository: wrong};
  expect(testBuildSourceSchema.safeParse(source).success).toBe(false);
  expect(testBuildQuerySchema.safeParse({channel: "pr", pr: 12, platform: "ios-on-mac", repository: wrong}).success).toBe(false);
  const count = f.calls.length;
  await expect(f.gateway.resolve(source as any, "ios-on-mac")).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
 }
});

test("app build GitHub grants follow the selected repository and cannot relabel legacy supersession", async () => {
 const targets: Array<{scope: string; repository: string | undefined}> = [], urls: string[] = [];
 const repository = "Mentra-Community/Mentra";
 const appAuth = {async token(scope: string, target?: string) {targets.push({scope, repository: target}); return "scoped"}} as any;
 const gateway = new GithubTestBuildGateway({appAuth, fetch: (async (url: any) => {
  urls.push(String(url)); const target = String(url).includes(`/repos/${repository}/`) ? repository : REPO;
  return Response.json({...pr, head: {...pr.head, repo: {full_name: target}}});
 }) as typeof fetch});
 expect(await gateway.isPrSuperseded(12, HEAD, repository)).toBe(false);
 expect(await gateway.isPrSuperseded(12, HEAD)).toBe(false);
 expect(targets).toEqual([{scope: "source", repository}, {scope: "source", repository: REPO}]);
 expect(urls).toEqual([`https://api.github.com/repos/${repository}/pulls/12`, `${API}/pulls/12`]);
});

test('PR admission freezes every member from its already verified inventory build', async () => {
  const f = fixture(), source = {channel: 'pr' as const, prNumber: 12, buildRunId: 50, publicationAttempt: 1};
  const verified = await f.gateway.resolve(source, 'ios-on-mac');
  expect(verified.availability).toBe('available');
  const baselineReads = f.calls.filter(call => call.url.startsWith('https://api.github.com/')).length;
  expect(baselineReads).toBe(4);
  let inventories = 0;
  const checks = new PrRoutineCheckService(undefined, undefined, new RoutineJobService(undefined, f.gateway), undefined, undefined,
    {async inventory() {inventories++; return [verified]}});
  const gate = {gateId: 'pr-build-reuse', headSha: HEAD, coverageGeneration: 1, context: pr,
    routineRevision: HEAD, routineRepository: 'Mentra-Community/Mentra',
    attempt: {generation: 1, deadline: '2026-10-27T20:00:00Z', members: ['alpha', 'beta', 'gamma'].map(id =>
      ({memberId: id, routineId: id, platform: 'ios-on-mac', title: id}))}};
  f.calls.length = 0;
  expect(await (checks as any).freezeAdmissions(gate)).toBe(true);
  expect(inventories).toBe(1);
  expect(f.calls.filter(call => call.url.startsWith('https://api.github.com/'))).toHaveLength(0);
  expect(f.calls).toHaveLength(0);
  for (const member of gate.attempt.members as any[]) {
    expect(member.selection.build).toEqual({...selectedBuildInput(verified, 'ios-on-mac'),
      ...(verified.manifest ? {manifest: verified.manifest, manifestSha256: verified.manifestSha256} : {})});
    expect(member.selection.source).toEqual(source);
    expect(member.selection.routineRevision).toBe(HEAD);
    expect(member.requestDeadline).toBe(gate.attempt.deadline);
  }
  expect(await (checks as any).freezeAdmissions(gate)).toBe(false);
  expect(inventories).toBe(1);
});

test('PR inventory verification remains required before inherited build admission', async () => {
  const f = fixture();
  const checks = new PrRoutineCheckService(undefined, undefined, new RoutineJobService(undefined, f.gateway), undefined, undefined,
    {async inventory() {throw new Error('initial publication verification unavailable')}});
  const gate = {gateId: 'pr-build-refused', headSha: HEAD, coverageGeneration: 1, context: pr,
    routineRevision: HEAD, attempt: {generation: 1, deadline: '2026-10-27T20:00:00Z',
      members: [{memberId: 'alpha', routineId: 'alpha', platform: 'ios-on-mac', title: 'Alpha'}]}};
  await expect((checks as any).freezeAdmissions(gate)).rejects.toThrow('initial publication verification unavailable');
  expect((gate.attempt.members[0] as any).selection).toBeUndefined();
  expect(f.calls).toHaveLength(0);
});
