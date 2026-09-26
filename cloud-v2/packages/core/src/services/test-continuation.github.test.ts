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
  // A staging occurrence cannot be qualified by a dev-targeted candidate.
  f.packet.source = { ...f.packet.source, trigger: "staging", channel: "staging", branch: "staging" };
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("base");
  // Its open staging fix uses that exact PR build; the build gateway binds the staging base and backend.
  f.pr.base.ref = "staging";
  expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toEqual({ query: { channel: "pr", pr: 12 }, expectedHeadSha: head, automaticExpected: false });
  f.pr.labels = [{ name: "routine:no-glasses" }];
  expect((await f.gateway.target(f.packet, f.grant, "no-glasses")).automaticExpected).toBe(true);
  for (const breakCandidate of [(g: ReturnType<typeof fixture>) => { g.pr.head.ref = "other"; },
    (g: ReturnType<typeof fixture>) => { g.diverged(); }]) {
    const g = fixture(); g.packet.source = f.packet.source; g.pr.head.ref = "fix/routine-run_123"; g.pr.base.ref = "staging";
    breakCandidate(g);
    await expect(g.gateway.target(g.packet, g.grant, "no-glasses")).rejects.toThrow();
  }
  // After merge the candidate is qualified only by its exact coordinated staging publication.
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
test("an adopted harness candidate uses only the recorded same-case owner's branch", async () => {
  const f = fixture(true); f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z";
  f.pr.head.ref = "fix/routine-run_owner";
  const bound = { ...f.grant, agentRunId: "run_sibling", caseBinding: { caseId: "mfc_" + "5".repeat(64), candidateOwnerRunId: "run_owner" } };
  expect(await f.gateway.target(f.packet, bound, "no-glasses")).toMatchObject({ expectedHeadSha: tested, expectedHarnessSha: merged });
  // Without the binding a sibling cannot address the owner's branch, and a wrong owner fails closed.
  await expect(f.gateway.target(f.packet, { ...bound, caseBinding: undefined }, "no-glasses")).rejects.toThrow("branch");
  await expect(f.gateway.target(f.packet, { ...bound, caseBinding: { ...bound.caseBinding, candidateOwnerRunId: "run_other" } }, "no-glasses")).rejects.toThrow("branch");
  await expect(f.gateway.target(f.packet, { ...bound, agentRunId: "run_owner" }, "no-glasses")).rejects.toThrow("adopted shared harness");
  const app = fixture();
  await expect(app.gateway.target(app.packet, { ...app.grant, caseBinding: bound.caseBinding }, "no-glasses")).rejects.toThrow("adopted shared harness");
  expect(app.calls).toEqual([]);
});
const collisions = (anchor: string) => [`codex/routine-${anchor}x`, `codex/routine-${anchor.slice(0, -1)}`, `codex/routine-${anchor}-2`,
  `codex/routine-${anchor}/x`, `fix/codex/routine-${anchor}`, `codex/fix/routine-${anchor}`, `routine-${anchor}`, `refs/heads/codex/routine-${anchor}`,
  `Codex/routine-${anchor}`, ` codex/routine-${anchor}`, `codex/routine-${anchor} `, "codex/routine-", "codex/routine-run_other", "fix/routine-run_other"];
test("new case fixes admit exactly the codex or legacy fix branch of their anchor", async () => {
  for (const channel of ["dev", "staging"] as const) {
    const setup = (ref: string) => { const f = fixture(); f.packet.source = { schemaVersion: 1, trigger: channel, channel, repository: PUB, branch: channel, headSha: tested };
      f.pr.base.ref = channel; f.pr.head.ref = ref; return f; };
    for (const ref of ["codex/routine-run_123", "fix/routine-run_123"]) {
      const f = setup(ref);
      expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toEqual({ query: { channel: "pr", pr: 12 }, expectedHeadSha: head, automaticExpected: false });
      f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z";
      expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ query: { channel }, expectedHeadSha: merged });
      // Repository, current head, base and tested ancestry still bind the new name.
      for (const breakCandidate of [(g: ReturnType<typeof fixture>) => { g.pr.head.repo.full_name = "other/repo" as typeof PUB; },
        (g: ReturnType<typeof fixture>) => { g.pr.head.sha = merged; }, (g: ReturnType<typeof fixture>) => { g.pr.base.ref = channel === "dev" ? "staging" : "dev"; },
        (g: ReturnType<typeof fixture>) => { g.diverged(); }, (g: ReturnType<typeof fixture>) => { g.pr.state = "closed"; }]) {
        const g = setup(ref); breakCandidate(g);
        await expect(g.gateway.target(g.packet, g.grant, "no-glasses")).rejects.toThrow();
      }
    }
    for (const ref of collisions("run_123")) {
      const f = setup(ref);
      await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("branch");
    }
    // A different run's grant cannot address this case's branch.
    const other = setup("codex/routine-run_123");
    await expect(other.gateway.target(other.packet, { ...other.grant, agentRunId: "run_1234" }, "no-glasses")).rejects.toThrow("branch");
  }
});
test("an originating PR never substitutes an anchor-derived branch", async () => {
  for (const ref of ["codex/routine-run_123", "fix/routine-run_123"]) {
    const f = fixture(); f.pr.head.ref = ref;
    await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("branch");
    // Even when its recorded branch has that name, the PR number stays bound.
    f.packet.source!.branch = ref;
    expect((await f.gateway.target(f.packet, f.grant, "no-glasses")).query).toEqual({ channel: "pr", pr: 12 });
    f.packet.source!.pullRequest!.number = 13;
    await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("originating PR");
  }
});
test("harness candidates and adopted owners admit the exact codex or legacy owner branch", async () => {
  const mergedHarness = (ref: string) => { const f = fixture(true); f.pr.head.ref = ref;
    f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z"; return f; };
  for (const ref of ["codex/routine-run_123", "fix/routine-run_123"]) {
    const f = mergedHarness(ref);
    expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ expectedHeadSha: tested, expectedHarnessSha: merged });
    const open = fixture(true); open.pr.head.ref = ref;
    await expect(open.gateway.target(open.packet, open.grant, "no-glasses")).rejects.toThrow("review and merge");
    const moved = mergedHarness(ref); moved.moveMain();
    await expect(moved.gateway.target(moved.packet, moved.grant, "no-glasses")).rejects.toThrow("Private main changed");
    const diverged = mergedHarness(ref); diverged.diverged();
    await expect(diverged.gateway.target(diverged.packet, diverged.grant, "no-glasses")).rejects.toThrow("descend");
  }
  for (const ref of collisions("run_123")) {
    const f = mergedHarness(ref);
    await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("branch");
  }
  const caseBinding = { caseId: "mfc_" + "5".repeat(64), candidateOwnerRunId: "run_owner" };
  for (const ref of ["codex/routine-run_owner", "fix/routine-run_owner"]) {
    const f = mergedHarness(ref), bound = { ...f.grant, agentRunId: "run_sibling", caseBinding };
    expect(await f.gateway.target(f.packet, bound, "no-glasses")).toMatchObject({ expectedHeadSha: tested, expectedHarnessSha: merged });
    await expect(f.gateway.target(f.packet, { ...bound, caseBinding: undefined }, "no-glasses")).rejects.toThrow("branch");
    await expect(f.gateway.target(f.packet, { ...bound, caseBinding: { ...caseBinding, candidateOwnerRunId: "run_other" } }, "no-glasses")).rejects.toThrow("branch");
  }
  // The binding makes the owner, not the consuming sibling, the only anchor.
  for (const ref of ["codex/routine-run_sibling", "fix/routine-run_sibling", ...collisions("run_owner")]) {
    const f = mergedHarness(ref);
    await expect(f.gateway.target(f.packet, { ...f.grant, agentRunId: "run_sibling", caseBinding }, "no-glasses")).rejects.toThrow("branch");
  }
});
