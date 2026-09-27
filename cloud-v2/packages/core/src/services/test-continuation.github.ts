import { z } from "zod";
import { isOriginalCandidate, type ContinuationCandidate, type ContinuationGrant } from "../types/test-continuation.types";
import type { TestBuildQuery } from "../types/test-dispatch.types";
import { TestDispatchError, readTestMetadata } from "./test-builds.service";
import { TestRunGithubApp } from "./test-run-github-app";
import type { TestRunService } from "./test-run.service";

export type FailurePacket = Awaited<ReturnType<TestRunService["failureDetail"]>>;
export interface ContinuationTarget {
  query: Omit<TestBuildQuery, "routineId">;
  expectedHeadSha: string;
  expectedHarnessSha?: string;
  automaticExpected: boolean;
  requestNotBefore?: string;
  /** Original target only: the exact recorded artifact and the request that selected it.
   * Requests are never adopted, so the original (or any earlier) one cannot stand in for the rerun. */
  original?: { archiveSha256: string; requestRunId: number };
}
export interface ContinuationSourceGateway {
  target(packet: FailurePacket, grant: ContinuationGrant, routineId: string): Promise<ContinuationTarget>;
}
const PUBLIC = "Mentra-Community/MentraOS";
const HARNESS = "Mentra-Community/Mentra-Automated-Testing";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const prSchema = z.object({ number: z.number().int().positive(), state: z.string(), merged: z.boolean(), merge_commit_sha: sha.nullable(), merged_at: z.string().datetime({ offset: true }).nullable(),
  head: z.object({ sha, ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  labels: z.array(z.object({ name: z.string() })) });
const ensure = (value: unknown, message: string): void => { if (!value) throw new TestDispatchError(409, message); };

/** Fixed repositories and read-only App scopes. Model text cannot choose a host or ref. */
export class GithubContinuationSource implements ContinuationSourceGateway {
  constructor(private readonly options: { app?: TestRunGithubApp; fetch?: typeof fetch } = {}) { this.app = options.app ?? new TestRunGithubApp(); }
  private readonly app: TestRunGithubApp;
  private async api(repository: typeof PUBLIC | typeof HARNESS, path: string): Promise<unknown> {
    const token = await this.app.token(repository === PUBLIC ? "source" : "harness");
    const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    return JSON.parse(new TextDecoder().decode(await readTestMetadata(response, 2 * 1024 * 1024)));
  }
  async target(packet: FailurePacket, grant: ContinuationGrant, routineId: string): Promise<ContinuationTarget> {
    const source = packet.source;
    ensure(source?.repository === PUBLIC && source.channel !== "local", "Published app source provenance is required");
    const candidate = grant.candidate;
    if (isOriginalCandidate(candidate)) return this.original(packet, grant, candidate, routineId);
    const harness = candidate.repository === HARNESS;
    const tested = harness ? packet.build.hashes.harnessSha ?? packet.build.hashes.harnessRevision : source!.headSha;
    ensure(typeof tested === "string" && /^[a-f0-9]{40}$/.test(tested), "The tested component revision is missing");
    // Only a shared harness candidate may name another same-case anchor as its owner;
    // app fixes always follow the consuming branch. Dispatch verifies the binding
    // through the lease callback before this lookup.
    const owner = grant.caseBinding?.candidateOwnerRunId;
    ensure(!owner || (harness && owner !== grant.agentRunId), "A case candidate binding applies only to an adopted shared harness candidate");
    const pr = prSchema.parse(await this.api(candidate.repository, `pulls/${candidate.pullRequest}`));
    const base = harness ? "main" : source!.pullRequest?.baseBranch ?? source!.branch;
    // An originating PR keeps its recorded branch. A newly allocated case branch is
    // exactly `codex/routine-<anchor>`, or the legacy `fix/routine-<anchor>` of frozen cases.
    const anchor = owner ?? grant.agentRunId;
    const branches = !harness && source!.pullRequest ? [source!.branch] : [`codex/routine-${anchor}`, `fix/routine-${anchor}`];
    ensure(pr.number === candidate.pullRequest && pr.head.repo?.full_name === candidate.repository
      && pr.base.repo.full_name === candidate.repository && pr.head.sha === candidate.headSha
      && branches.includes(pr.head.ref) && pr.base.ref === base, "Candidate repository, branch, base or current head differs");
    ensure(harness || !source!.pullRequest || source!.pullRequest.number === pr.number, "Use the originating PR");
    ensure(["dev", "staging"].includes(base) || harness, "Candidate destination is not admitted");
    ensure(pr.state === "open" || pr.merged, "Candidate PR closed without merging");
    const comparison = z.object({ status: z.enum(["ahead", "identical", "behind", "diverged"]) }).parse(
      await this.api(candidate.repository, `compare/${tested}...${candidate.headSha}`));
    ensure(["ahead", "identical"].includes(comparison.status), "Candidate does not descend from the tested source");
    if (harness) {
      ensure(pr.merged && pr.merge_commit_sha && pr.merged_at, "Harness changes require review and merge before device execution");
      const ref = z.object({ ref: z.literal("refs/heads/main"), object: z.object({ type: z.literal("commit"), sha }) }).parse(
        await this.api(HARNESS, "git/ref/heads/main"));
      ensure(ref.object.sha === pr.merge_commit_sha, "Private main changed; qualify an explicitly reviewed worker revision");
      return { query: source!.channel === "pr" ? { channel: "pr", pr: source!.pullRequest!.number }
        : { channel: source!.channel as "dev" | "staging" }, expectedHeadSha: source!.headSha,
        expectedHarnessSha: pr.merge_commit_sha!, requestNotBefore: pr.merged_at!, automaticExpected: false };
    }
    if (pr.merged) {
      ensure(pr.merge_commit_sha, "Merged candidate has no merge commit");
      return { query: { channel: base as "dev" | "staging" }, expectedHeadSha: pr.merge_commit_sha!,
        automaticExpected: routineId === "no-glasses" || routineId === "no-glasses-android" };
    }
    // Open dev and staging candidates use their exact PR build; the gateway binds
    // its merge to the PR's current base tip and its app to that base's backend.
    return { query: { channel: "pr", pr: pr.number }, expectedHeadSha: candidate.headSha,
      automaticExpected: pr.labels.some(label => label.name === `routine:${routineId}`) };
  }
  /** The occurrence's own recorded source, channel, routine and artifact. Nothing is looked
   * up by branch or PR, so a newer head or another environment's build cannot substitute. */
  private original(packet: FailurePacket, grant: ContinuationGrant, candidate: ContinuationCandidate, routineId: string): ContinuationTarget {
    const source = packet.source!, archiveSha256 = packet.build.hashes.archiveSha256;
    ensure(candidate.repository === source.repository && candidate.headSha === source.headSha,
      "The original target is the occurrence's exact recorded source");
    ensure(!grant.caseBinding, "The original target belongs to its own occurrence, not a shared candidate");
    ensure(packet.routine.id === routineId, "The original target reruns only the recorded routine");
    ensure(typeof archiveSha256 === "string" && /^[a-f0-9]{64}$/.test(archiveSha256), "The original artifact identity was not recorded");
    // The trusted issuer's request that selected this exact build; its immutable artifact,
    // not the caller, later names the build run and publication attempt.
    const suffix = source.channel === "pr" ? String(source.pullRequest!.number) : source.channel;
    const request = new RegExp(`^routine-([1-9]\\d*)-1-${suffix}-${routineId}$`).exec(packet.requestId);
    ensure(request, "The original request identity was not recorded");
    return { query: source.channel === "pr" ? { channel: "pr", pr: source.pullRequest!.number } : { channel: source.channel as "dev" | "staging" },
      expectedHeadSha: source.headSha, automaticExpected: false, original: { archiveSha256: archiveSha256!, requestRunId: Number(request![1]) } };
  }
}
