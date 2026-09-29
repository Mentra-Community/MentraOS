import { expect, test } from "bun:test";
import { GithubContinuationSource, type FailurePacket } from "./test-continuation.github";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestRunGithubApp } from "./test-run-github-app";

const repository = "Mentra-Community/Mentra-Automated-Testing", head = "a".repeat(40), tested = "b".repeat(40);
const merge = "c".repeat(40), selectedMerge = "d".repeat(40), selectedHead = "e".repeat(40), main = "f".repeat(40);
function fixture() {
  const candidate = { repository, pullRequest: 217, headSha: head };
  const grant = { agentRunId: "owner", candidate, harnessVerification: { pullRequest: 225, mergeCommitSha: selectedMerge } } as ContinuationGrant;
  const packet = { sourceStatus: "recorded", platform: "ios-on-mac", routine: { id: "notes-phone" },
    source: { schemaVersion: 1, channel: "local", repository: "Mentra-Community/MentraOS", branch: "dev", headSha: tested },
    build: { hashes: { harnessSha: tested }, recordedAppPublication: { producerRunId: 468,
      executableSha256: "1".repeat(64), javascriptSha256: "2".repeat(64) } } } as unknown as FailurePacket;
  const pr = { number: 217, state: "closed", merged: true, merge_commit_sha: merge, merged_at: "2026-09-29T12:00:00Z",
    head: { sha: head, ref: "codex/routine-owner", repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } }, labels: [] };
  const selected = { ...structuredClone(pr), number: 225, merge_commit_sha: selectedMerge, merged_at: "2026-09-29T17:00:00Z",
    head: { sha: selectedHead, ref: "codex/compatible-audio", repo: { full_name: repository } } };
  const reviews = [{ id: 1, commit_id: selectedHead, state: "COMMENTED", submitted_at: "2026-09-29T16:00:00Z",
    user: { login: "PhilippeFerreiraDeSousa" }, body: "Approve.\n\nReviewed by local Codex (gpt-6-astra, medium)." }];
  const relations = new Map<string, string>(), calls: string[] = [];
  const gateway = new GithubContinuationSource({ app: { token: async scope => { expect(scope).toBe("harness"); return "test-only"; } } as TestRunGithubApp,
    fetch: (async (url: string) => {
      calls.push(url); const path = url.split(`${repository}/`)[1]!;
      if (path === "pulls/217") return Response.json(pr);
      if (path === "pulls/225") return Response.json(selected);
      if (path === "pulls/225/reviews?per_page=100") return Response.json(reviews);
      if (path === "git/ref/heads/main") return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: main } });
      if (path.startsWith("compare/")) return Response.json({ status: relations.get(path) ?? "ahead" });
      throw new Error(`Unexpected metadata path ${path}`);
    }) as typeof fetch });
  return { grant, packet, pr, selected, reviews, relations, calls, gateway };
}
test("explicit reviewed descendant changes only the verification harness and keeps the local app and candidate", async () => {
  const f = fixture(), original = structuredClone({ grant: f.grant, packet: f.packet });
  const target = await f.gateway.target(f.packet, f.grant, "notes-phone");
  expect(target).toMatchObject({ expectedHarnessSha: selectedMerge, expectedHeadSha: tested,
    requestNotBefore: f.selected.merged_at, localPublication: { ...f.packet.build.recordedAppPublication, channel: "dev" } });
  expect({ grant: f.grant, packet: f.packet }).toEqual(original);
  expect(f.calls).toContain(`https://api.github.com/repos/${repository}/compare/${merge}...${selectedMerge}?per_page=1&page=2`);
  expect(f.calls).toContain(`https://api.github.com/repos/${repository}/compare/${selectedMerge}...${main}?per_page=1&page=2`);
  expect((await f.gateway.target(f.packet, { ...f.grant, harnessVerification: undefined }, "notes-phone")).expectedHarnessSha).toBe(merge);
});
test.each(["candidate-not-contained", "selected-not-main", "head-repo", "base-repo", "base", "unmerged", "merge", "number"])(
  "selected harness refuses %s", async failure => {
    const f = fixture();
    if (failure === "candidate-not-contained") f.relations.set(`compare/${merge}...${selectedMerge}?per_page=1&page=2`, "diverged");
    if (failure === "selected-not-main") f.relations.set(`compare/${selectedMerge}...${main}?per_page=1&page=2`, "behind");
    if (failure === "head-repo") f.selected.head.repo.full_name = "other/repo";
    if (failure === "base-repo") f.selected.base.repo.full_name = "other/repo";
    if (failure === "base") f.selected.base.ref = "dev";
    if (failure === "unmerged") f.selected.merged = false;
    if (failure === "merge") f.selected.merge_commit_sha = main;
    if (failure === "number") f.selected.number++;
    await expect(f.gateway.target(f.packet, f.grant, "notes-phone")).rejects.toThrow();
  });
test.each(["wrong-head", "untrusted", "unmarked-comment", "dismissed", "requested-changes", "other-reviewer-changes", "incomplete"])(
  "explicit verification refuses missing/current review proof: %s", async failure => {
    const f = fixture();
    if (failure === "wrong-head") f.reviews[0]!.commit_id = head;
    if (failure === "untrusted") f.reviews[0]!.user.login = "unrelated";
    if (failure === "unmarked-comment") f.reviews[0]!.body = "Approve. Looks fine.";
    if (failure === "dismissed") f.reviews[0]!.state = "DISMISSED";
    if (failure === "requested-changes") f.reviews.push({ ...f.reviews[0]!, id: 2, body: "Request changes.\nReviewed by local Codex" });
    if (failure === "other-reviewer-changes") f.reviews.push({ ...f.reviews[0]!, id: 2, state: "CHANGES_REQUESTED", user: { login: "reviewer" } });
    if (failure === "incomplete") while (f.reviews.length < 100) f.reviews.push({ ...f.reviews[0]!, id: f.reviews.length + 1 });
    await expect(f.gateway.target(f.packet, f.grant, "notes-phone")).rejects.toThrow();
  });
test("formal approval supersedes that reviewer's earlier change request; ordinary comments do not supersede verdicts", async () => {
  const f = fixture(); f.reviews[0]!.state = "CHANGES_REQUESTED";
  f.reviews.push({ ...f.reviews[0]!, id: 2, state: "APPROVED", body: "Approved" });
  f.reviews.push({ ...f.reviews[0]!, id: 3, state: "COMMENTED", body: "Additional context" });
  expect((await f.gateway.target(f.packet, f.grant, "notes-phone")).expectedHarnessSha).toBe(selectedMerge);
});
test("the latest submitted verdict takes precedence without inferring submission order from review IDs", async () => {
  const f = fixture(); f.reviews[0]!.id = 2;
  f.reviews.push({ ...f.reviews[0]!, id: 1, submitted_at: "2026-09-29T16:30:00Z", state: "CHANGES_REQUESTED" });
  await expect(f.gateway.target(f.packet, f.grant, "notes-phone")).rejects.toThrow("current approved review");
});
test("original and app candidates cannot select another harness", async () => {
  for (const candidate of [{ repository, headSha: head, target: "original" },
    { repository: "Mentra-Community/MentraOS", headSha: head, pullRequest: 217 }]) {
    const f = fixture();
    await expect(f.gateway.target(f.packet, { ...f.grant, candidate } as ContinuationGrant, "notes-phone")).rejects.toThrow("requires a harness PR");
    expect(f.calls).toEqual([]);
  }
});
