import {expect, test} from "bun:test";
import {GithubTestBuildGateway} from "./test-builds.service";
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
 expect(f.calls.every(call => !call.init?.method || ["GET", "HEAD"].includes(call.init.method))).toBe(true);
});
test("wrong archive size and moved PR base cannot become selectable", async () => {
 for (const kind of ["size", "base"]) {
  const f = fixture();
  if (kind === "size") f.rows.set(`HEAD ${CDN}pr-builds/${f.receipt.artifacts.mac.name}`, new Response(null, {headers: {"Content-Length": "99"}}));
  else f.rows.set(`${API}/git/ref/heads/dev`, {ref: "refs/heads/dev", object: {type: "commit", sha: "e".repeat(40)}});
  expect((await f.gateway.resolve({channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1}, "ios-on-mac")).availability).toBe("unavailable");
 }
});
