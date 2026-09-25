import { expect, test } from "bun:test";
import { GithubContinuationSource, type FailurePacket } from "./test-continuation.github";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestRunGithubApp } from "./test-run-github-app";
const PUB = "Mentra-Community/MentraOS", HARNESS = "Mentra-Community/Mentra-Automated-Testing";
const head = "a".repeat(40), tested = "b".repeat(40), merged = "c".repeat(40);
function fixture(harness = false) {
  const grant = { agentRunId: "run_123", candidate: { repository: harness ? HARNESS : PUB, pullRequest: 12, headSha: head } } as ContinuationGrant;
  const packet = { source: { schemaVersion: 1, channel: "pr", repository: PUB, branch: "candidate", headSha: tested,
    pullRequest: { number: 12, headRepository: PUB, baseBranch: "dev", baseSha: merged } }, build: { hashes: { harnessSha: tested } } } as unknown as FailurePacket;
  const pr = { number: 12, state: "open", merged: false, merge_commit_sha: null as string | null, merged_at: null as string | null,
    head: { sha: head, ref: harness ? "fix/routine-run_123" : "candidate", repo: { full_name: grant.candidate.repository } },
    base: { ref: harness ? "main" : "dev", repo: { full_name: grant.candidate.repository } }, labels: [] as { name: string }[] };
  const calls: string[] = []; let status = "ahead", main = merged;
  const gateway = new GithubContinuationSource({ app: { token: async (scope: string) => { expect(scope).toBe(harness ? "harness" : "source"); return "fixture"; } } as TestRunGithubApp,
    fetch: (async (url: string, init?: RequestInit) => { calls.push(url); expect(init?.method).toBeUndefined();
      if (url.endsWith("/pulls/12")) return Response.json(pr);
      if (url.includes("/compare/")) return Response.json({ status });
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: main } });
      throw new Error("Unexpected endpoint"); }) as typeof fetch });
  return { grant, packet, pr, gateway, calls, diverged: () => { status = "diverged"; }, moveMain: () => { main = head; } };
}
test("originating PR retains exact branch/base/repository/head and tested ancestry", async () => {
  const good = fixture(); expect(await good.gateway.target(good.packet, good.grant, "no-glasses")).toMatchObject({ query: { channel: "pr", pr: 12 }, expectedHeadSha: head });
  for (const field of ["branch", "base", "repo", "head", "pr", "ancestry", "source"]) {
    const f = fixture();
    if (field === "branch") f.pr.head.ref = "other";
    if (field === "base") f.pr.base.ref = "staging";
    if (field === "repo") f.pr.head.repo.full_name = "other/repo" as typeof PUB;
    if (field === "head") f.pr.head.sha = merged;
    if (field === "pr") f.packet.source!.pullRequest!.number = 13;
    if (field === "ancestry") f.diverged();
    if (field === "source") f.packet.source = null;
    await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow();
  }
});
test("dev fixes use the saved case branch; staging cannot silently test a dev artifact", async () => {
  const f = fixture(); f.packet.source = { schemaVersion: 1, trigger: "dev", channel: "dev", repository: PUB, branch: "dev", headSha: tested };
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("branch");
  f.pr.head.ref = "fix/routine-run_123";
  expect((await f.gateway.target(f.packet, f.grant, "no-glasses")).query.channel).toBe("pr");
  f.packet.source = { ...f.packet.source, trigger: "staging", channel: "staging", branch: "staging" }; f.pr.base.ref = "staging";
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("Staging candidates");
  f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z";
  expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ query: { channel: "staging" }, expectedHeadSha: merged });
});
test("harness route requires recorded tested revision and the merged current private worker", async () => {
  const f = fixture(true);
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("review and merge");
  f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z";
  expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ expectedHeadSha: tested, expectedHarnessSha: merged, requestNotBefore: f.pr.merged_at });
  delete f.packet.build.hashes.harnessSha;
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("revision is missing");
  f.packet.build.hashes.harnessSha = tested; f.moveMain();
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("Private main changed");
});
