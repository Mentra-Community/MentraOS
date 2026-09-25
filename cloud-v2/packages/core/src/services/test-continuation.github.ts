import { z } from "zod";
import type { ContinuationGrant } from "../types/test-continuation.types";
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
    const candidate = grant.candidate, harness = candidate.repository === HARNESS;
    const tested = harness ? packet.build.hashes.harnessSha ?? packet.build.hashes.harnessRevision : source!.headSha;
    ensure(typeof tested === "string" && /^[a-f0-9]{40}$/.test(tested), "The tested component revision is missing");
    const pr = prSchema.parse(await this.api(candidate.repository, `pulls/${candidate.pullRequest}`));
    const base = harness ? "main" : source!.pullRequest?.baseBranch ?? source!.branch;
    const branch = !harness && source!.pullRequest ? source!.branch : `fix/routine-${grant.agentRunId}`;
    ensure(pr.number === candidate.pullRequest && pr.head.repo?.full_name === candidate.repository
      && pr.base.repo.full_name === candidate.repository && pr.head.sha === candidate.headSha
      && pr.head.ref === branch && pr.base.ref === base, "Candidate repository, branch, base or current head differs");
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
    ensure(base === "dev", "Staging candidates require their exact merged coordinated artifact; PR artifacts target dev");
    return { query: { channel: "pr", pr: pr.number }, expectedHeadSha: candidate.headSha,
      automaticExpected: pr.labels.some(label => label.name === `routine:${routineId}`) };
  }
}
