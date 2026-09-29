import { expect, test } from "bun:test";
import { GithubContinuationSource, type FailurePacket } from "./test-continuation.github";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestRunGithubApp } from "./test-run-github-app";
const PUB = "Mentra-Community/MentraOS", HARNESS = "Mentra-Community/Mentra-Automated-Testing";
const head = "a".repeat(40), tested = "b".repeat(40), merged = "c".repeat(40);
function fixture(harness = false) {
  const grant = { agentRunId: "run_123", candidate: { repository: harness ? HARNESS : PUB, pullRequest: 12, headSha: head } } as ContinuationGrant;
  const packet = { source: { schemaVersion: 1, channel: "pr", repository: PUB, branch: "candidate", headSha: tested,
    pullRequest: { number: 12, headRepository: PUB, baseBranch: "dev", baseSha: merged } },
    requestId: "routine-70-1-12-no-glasses", routine: { id: "no-glasses", version: "1" },
    build: { hashes: { harnessSha: tested, archiveSha256: "d".repeat(64) } } } as unknown as FailurePacket;
  const pr = { number: 12, state: "open", merged: false, merge_commit_sha: null as string | null, merged_at: null as string | null,
    head: { sha: head, ref: harness ? "fix/routine-run_123" : "candidate", repo: { full_name: grant.candidate.repository } },
    base: { ref: harness ? "main" : "dev", repo: { full_name: grant.candidate.repository } }, labels: [] as { name: string }[] };
  const calls: string[] = []; let status = "ahead", mainStatus = "identical", main = merged, largeMainFiles = false;
  const gateway = new GithubContinuationSource({ app: { token: async (scope: string) => { expect(scope).toBe(harness ? "harness" : "source"); return "fixture"; } } as TestRunGithubApp,
    fetch: (async (url: string, init?: RequestInit) => { calls.push(url); expect(init?.method).toBeUndefined();
      if (url.endsWith("/pulls/12")) return Response.json(pr);
      if (url.includes(`/compare/${merged}...`)) return Response.json({ status: mainStatus,
        ...(largeMainFiles && new URL(url).searchParams.get("page") !== "2" ? {files: [{patch: "x".repeat(3 * 1024 * 1024)}]} : {}) });
      if (url.includes("/compare/")) return Response.json({ status });
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: main } });
      throw new Error("Unexpected endpoint"); }) as typeof fetch });
  return { grant, packet, pr, gateway, calls, diverged: () => { status = "diverged"; }, moveMain: () => { main = head; mainStatus = "ahead"; }, excludeMerge: (value = "diverged") => { mainStatus = value; }, largeMainFiles: () => { largeMainFiles = true; } };
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
test("harness route requires recorded tested revision and the reviewed merge still contained in private main", async () => {
  const f = fixture(true);
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("review and merge");
  f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z";
  expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ expectedHeadSha: tested, expectedHarnessSha: merged, requestNotBefore: f.pr.merged_at });
  delete f.packet.build.hashes.harnessSha;
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("revision is missing");
  f.packet.build.hashes.harnessSha = tested; f.moveMain();
  expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ expectedHarnessSha: merged });
  expect(f.calls.at(-1)).toContain(`/compare/${merged}...${head}?per_page=1&page=2`);
  for (const status of ["behind", "diverged", "unknown"]) {
    f.excludeMerge(status);
    await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow();
  }
});
test("private main containment omits oversized unrelated patches while preserving exact ancestry", async () => {
  const f = fixture(true); f.largeMainFiles();
  f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z";
  // The identical comparison has no second commit, but still carries its global status.
  expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ expectedHarnessSha: merged });
  f.moveMain();
  expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ expectedHarnessSha: merged });
  // Omitting the patch list must not weaken rejection of a rewritten main history.
  f.excludeMerge("diverged");
  await expect(f.gateway.target(f.packet, f.grant, "no-glasses")).rejects.toThrow("no longer contains");
});
test("CI harness candidates bind the consuming occurrence's original request and artifact", async () => {
  for (const channel of ["pr", "dev", "staging"] as const) {
    const f = fixture(true); f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-25T09:00:00Z";
    if (channel !== "pr") f.packet.source = { schemaVersion: 1, trigger: channel, channel, repository: PUB, branch: channel, headSha: tested };
    f.packet.requestId = `routine-70-1-${channel === "pr" ? 12 : channel}-no-glasses`;
    const before = structuredClone(f.packet);
    expect(await f.gateway.target(f.packet, f.grant, "no-glasses")).toMatchObject({ expectedHeadSha: tested,
      expectedHarnessSha: merged, original: { requestRunId: 70, archiveSha256: "d".repeat(64) } });
    expect(f.packet).toEqual(before);
    for (const problem of ["request", "archive", "routine"]) {
      f.packet.requestId = problem === "request" ? "routine-70-2-dev-no-glasses" : before.requestId;
      if (problem === "archive") delete f.packet.build.hashes.archiveSha256;
      else f.packet.build.hashes.archiveSha256 = before.build.hashes.archiveSha256!;
      await expect(f.gateway.target(f.packet, f.grant, problem === "routine" ? "day1-ota" : "no-glasses")).rejects.toThrow();
    }
  }
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
    expect(await moved.gateway.target(moved.packet, moved.grant, "no-glasses")).toMatchObject({ expectedHarnessSha: merged });
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

test("original target resolves only the occurrence's recorded source, channel, routine and artifact, with no GitHub lookup", async () => {
  const archiveSha256 = "d".repeat(64);
  const setup = () => {
    const f = fixture();
    const grant = { ...f.grant, candidate: { repository: PUB, headSha: tested, target: "original" as const } } as ContinuationGrant;
    const packet = { ...f.packet, requestId: "routine-70-1-12-no-glasses", routine: { id: "no-glasses", version: "1" }, build: { hashes: { archiveSha256 } } } as unknown as FailurePacket;
    return { ...f, grant, packet };
  };
  const pr = setup();
  expect(await pr.gateway.target(pr.packet, pr.grant, "no-glasses")).toEqual({ query: { channel: "pr", pr: 12 }, expectedHeadSha: tested,
    automaticExpected: false, original: { archiveSha256, requestRunId: 70 } });
  expect(pr.calls).toEqual([]);
  // A dev occurrence stays on dev: its recorded channel is kept, never promoted or rebuilt.
  const dev = setup(); dev.packet.source = { schemaVersion: 1, trigger: "nightly", channel: "dev", repository: PUB, branch: "dev", headSha: tested };
  (dev.packet as { requestId: string }).requestId = "routine-71-1-dev-no-glasses";
  expect(await dev.gateway.target(dev.packet, dev.grant, "no-glasses")).toMatchObject({ query: { channel: "dev" }, original: { requestRunId: 71 } });
  for (const mismatch of ["head", "repository", "routine", "archive", "local", "shared", "request", "request-channel", "request-attempt"]) {
    const f = setup(); let routineId = "no-glasses";
    if (mismatch === "head") f.grant.candidate.headSha = head;
    if (mismatch === "repository") f.grant.candidate.repository = HARNESS;
    if (mismatch === "routine") routineId = "day1-ota";
    if (mismatch === "archive") (f.packet.build.hashes as Record<string, string>) = {};
    if (mismatch === "local") f.packet.source = { schemaVersion: 1, trigger: "local", channel: "local", repository: PUB, branch: "candidate", headSha: tested };
    if (mismatch === "shared") f.grant.caseBinding = { caseId: "mfc_" + "5".repeat(64), candidateOwnerRunId: "run_owner" };
    // The recorded request must be the trusted issuer's first generation for this exact PR/channel and routine.
    if (mismatch === "request") (f.packet as { requestId: string }).requestId = "local-2026-09-27";
    if (mismatch === "request-channel") (f.packet as { requestId: string }).requestId = "routine-70-1-dev-no-glasses";
    if (mismatch === "request-attempt") (f.packet as { requestId: string }).requestId = "routine-70-2-12-no-glasses";
    await expect(f.gateway.target(f.packet, f.grant, routineId)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
});

test("an authenticated local source is an unsupported replay, not an invalid source, and app fix PRs still verify", async () => {
  const local = (f: ReturnType<typeof fixture>) => {
    f.packet.source = { schemaVersion: 1, trigger: "local", channel: "local", repository: PUB, branch: "dev", headSha: tested };
    (f.packet as { requestId: string }).requestId = "local-run-1";
  };
  // Original target and harness candidate would rerun the exact local build: 501, before any GitHub lookup.
  const original = fixture(); local(original);
  const originalGrant = { ...original.grant, candidate: { repository: PUB, headSha: tested, target: "original" as const } } as ContinuationGrant;
  await expect(original.gateway.target(original.packet, originalGrant, "no-glasses")).rejects.toMatchObject({ status: 501 });
  const harness = fixture(true); local(harness);
  await expect(harness.gateway.target(harness.packet, harness.grant, "no-glasses")).rejects.toMatchObject({ status: 501 });
  expect([...original.calls, ...harness.calls]).toEqual([]);
  // An app fix PR for the recorded local branch is verified on its own PR build, as for published sources.
  const app = fixture(); local(app); app.pr.head.ref = "codex/routine-run_123";
  expect(await app.gateway.target(app.packet, app.grant, "no-glasses")).toMatchObject({ query: { channel: "pr", pr: 12 }, expectedHeadSha: head });
  // Untrusted provenance remains a refusal (409), never the capability result.
  const other = fixture(); other.packet.source = { ...other.packet.source!, repository: "someone/else" as typeof PUB };
  await expect(other.gateway.target(other.packet, other.grant, "no-glasses")).rejects.toMatchObject({ status: 409 });
});

test("local Notes uses its recorded publication only after the exact harness candidate is merged", async () => {
  // Selected identity from the real local dev468 Notes packet; no CI request is invented.
  const publication = { producerRunId: 36496912774,
    executableSha256: "3cd22e5a9ec9b62c55d0cf79df0aec71c721c3110e712127b3c131a46b4f1842",
    javascriptSha256: "f3bd02020c7b5d4d44d7768888be90e549ebdf15526e14c65532dcc990a8c423" };
  const setup = (channel: "dev" | "staging" = "dev") => {
    const f = fixture(true);
    f.packet.source = { schemaVersion: 1, trigger: "local", channel: "local", repository: PUB, branch: channel,
      headSha: "d6c74c857015fac95fbc6195dbf009acfab65eeb" };
    f.packet.sourceStatus = "recorded"; f.packet.platform = "ios-mac";
    f.packet.routine = { id: "notes-phone", version: "1" }; f.packet.build.recordedAppPublication = publication;
    f.packet.requestId = "notes-phone-22c2da8c-b863-4a03-b37f-4780f49d7fa0";
    f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = merged; f.pr.merged_at = "2026-09-29T13:00:00Z";
    return f;
  };
  for (const channel of ["dev", "staging"] as const) {
    const f = setup(channel), before = structuredClone(f.packet); f.moveMain();
    expect(await f.gateway.target(f.packet, f.grant, "notes-phone")).toEqual({ query: { channel },
      expectedHeadSha: f.packet.source!.headSha, expectedHarnessSha: merged, requestNotBefore: f.pr.merged_at!,
      automaticExpected: false, localPublication: { ...publication, channel } });
    expect(f.packet).toEqual(before);
  }
  for (const mismatch of ["missing", "bad-hash", "extra", "corrected", "platform", "branch", "routine", "unmerged", "main", "ancestry"]) {
    const f = setup();
    if (mismatch === "missing") delete f.packet.build.recordedAppPublication;
    if (mismatch === "bad-hash") f.packet.build.recordedAppPublication = { ...publication, executableSha256: "bad" };
    if (mismatch === "extra") f.packet.build.recordedAppPublication = { ...publication, arbitraryUrl: "https://other.invalid" } as typeof publication;
    if (mismatch === "corrected") f.packet.sourceStatus = "corrected";
    if (mismatch === "platform") f.packet.platform = "android";
    if (mismatch === "branch") f.packet.source!.branch = "feature";
    if (mismatch === "routine") f.packet.routine.id = "captions-phone";
    if (mismatch === "unmerged") f.pr.merged = false;
    if (mismatch === "main") f.excludeMerge();
    if (mismatch === "ancestry") f.diverged();
    await expect(f.gateway.target(f.packet, f.grant, "notes-phone")).rejects.toThrow();
  }
});
