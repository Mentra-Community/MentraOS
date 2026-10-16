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
 const receipt = {schemaVersion:1,diagnostic:'nimo-resource-v1',diagnosticVerification:{kind:'compiled-capture-wiring-v2',captureProtocol:'nimo-preconnect-capture-v1',apkSha256:HASH,wiringSha256:HASH,analyzer:{source:'android-sdk-command-line-tools',revision:'19.0',sha256:HASH}},pr:12,headSha:HEAD,baseSha:BASE,buildSha:MERGE,runId:50,runAttempt:1,
   app:{packageId:'com.mentra.mentra',version:'3.4.0',build:'42',headSha:HEAD,buildSha:MERGE,backend:'dev', diagnostic:'nimo-resource-v1',otaManifestUrl:`${CDN}pr-builds/ota-pr-12-${HEAD}.json`},
   artifacts:{android:{name:`${name}.apk`,sha256:HASH,size:100}}};
 f.rows.set(`${CDN}pr-builds/${name}.json`,receipt);
 f.rows.set(`HEAD ${CDN}pr-builds/${name}.apk`,new Response(null,{headers:{'Content-Length':'100'}}));
 const source = {channel:'pr' as const,prNumber:12,buildRunId:50,publicationAttempt:1};
 expect(await f.gateway.resolveNimoDiagnostic(source)).toMatchObject({availability:'available',diagnostic:'nimo-resource-v1'});
 for (const proof of [
   {...receipt.diagnosticVerification,kind:'compiled-receiver-wiring-v1'},
   {...receipt.diagnosticVerification,captureProtocol:undefined},
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
