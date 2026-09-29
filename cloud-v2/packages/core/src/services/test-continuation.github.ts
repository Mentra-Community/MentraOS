import { z } from "zod";
import { isOriginalCandidate, type ContinuationCandidate, type ContinuationExecutionDestination, type ContinuationGrant } from "../types/test-continuation.types";
import { recordedAppPublicationSchema, testBuildSourceSchema, type RecordedAppPublication, type TestBuildQuery, type TestBuildSource } from "../types/test-dispatch.types";
import { TestDispatchError, UnsupportedReplayError, readTestMetadata } from "./test-builds.service";
import { TestRunGithubApp } from "./test-run-github-app";
import type { TestRunService } from "./test-run.service";

export type FailurePacket = Awaited<ReturnType<TestRunService["failureDetail"]>>;
export interface ContinuationTarget {
  query: Omit<TestBuildQuery, "routineId">;
  expectedHeadSha: string;
  expectedHarnessSha?: string;
  automaticExpected: boolean;
  requestNotBefore?: string;
  /** The original CI app artifact, for an original target or a harness candidate.
   * Requests are never adopted, so the original (or any earlier) one cannot stand in for the rerun. */
  original?: { archiveSha256: string; requestRunId: number };
  recordedBuild?: { source: TestBuildSource; archiveSha256: string };
  localPublication?: RecordedAppPublication & { channel: "dev" | "staging" };
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
// GitHub lists at most 100 pull requests for a commit per page; a full page may hide another, so it is refused as incomplete.
const associatedSchema = z.array(z.object({ number: z.number().int().positive(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }) })).max(99);
const comparisonSchema = z.object({ status: z.enum(["ahead", "identical", "behind", "diverged"]) });
const ensure = (value: unknown, message: string): void => { if (!value) throw new TestDispatchError(409, message); };
// The same formal/fallback verdict convention as the enrolled Mini reviewer.
// A full page is refused rather than treating an incomplete history as approval.
const verificationReviewsSchema = z.array(z.object({ id: z.number().int().positive(), commit_id: sha,
  state: z.string(), body: z.string().nullable(), user: z.object({ login: z.string() }),
  submitted_at: z.string().datetime({ offset: true }).nullable() })).max(99);
function approvedVerificationHead(input: unknown, head: string): boolean {
  const latest = new Map<string, string>();
  for (const row of verificationReviewsSchema.parse(input).sort((a, b) =>
    Date.parse(a.submitted_at ?? "1970-01-01T00:00:00Z") - Date.parse(b.submitted_at ?? "1970-01-01T00:00:00Z") || a.id - b.id)) {
    if (row.commit_id !== head || !row.submitted_at) continue;
    const trusted = ["PhilippeFerreiraDeSousa", "mentra-release-coordinator[bot]"].includes(row.user.login);
    let verdict = row.state;
    if (verdict === "COMMENTED") {
      if (!trusted || !row.body?.includes("Reviewed by local Codex")) continue;
      verdict = /^Approve\.\s/.test(row.body) ? "APPROVED" : /^Request changes\.\s/.test(row.body) ? "CHANGES_REQUESTED" : "COMMENTED";
    }
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(verdict))
      latest.set(row.user.login, verdict === "APPROVED" && !trusted ? "UNTRUSTED" : verdict);
  }
  return [...latest.values()].includes("APPROVED") && ![...latest.values()].includes("CHANGES_REQUESTED");
}

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
    ensure(source?.repository === PUBLIC, "Recorded app source provenance is required");
    const candidate = grant.candidate;
    const harness = candidate.repository === HARNESS;
    ensure(!grant.harnessVerification || (harness && !isOriginalCandidate(candidate)),
      "A harness verification revision requires a harness PR candidate");
    // A local failure has no consumed CI request. A harness fix may instead use
    // its explicitly recorded app publication, independently verified below by
    // the build gateway; the original occurrence and source stay unchanged.
    let localPublication: ContinuationTarget["localPublication"];
    if (source!.channel === "local" && (isOriginalCandidate(candidate) || harness)) {
      if (isOriginalCandidate(candidate)) throw new UnsupportedReplayError("Unsupported replay: a local original target has no recorded CI request to replay");
      const publication = recordedAppPublicationSchema.safeParse(packet.build.recordedAppPublication);
      if (packet.sourceStatus !== "recorded" || !["ios-mac", "ios-on-mac"].includes(packet.platform) || !["dev", "staging"].includes(source!.branch)
        || packet.routine.id !== routineId || !publication.success)
        throw new UnsupportedReplayError("Local harness verification requires the recorded Mac app producer, executable and JavaScript hashes, "
          + "and the same routine on a dev or staging source branch");
      localPublication = { ...publication.data, channel: source!.branch as "dev" | "staging" };
    }
    const destination = grant.executionDestination;
    ensure(!destination || (!isOriginalCandidate(candidate) && !harness && !grant.caseBinding),
      "An execution destination applies only to this case's own app candidate");
    if (isOriginalCandidate(candidate)) return this.original(packet, grant, candidate, routineId);
    const tested = harness ? packet.build.hashes.harnessSha ?? packet.build.hashes.harnessRevision : source!.headSha;
    ensure(typeof tested === "string" && /^[a-f0-9]{40}$/.test(tested), "The tested component revision is missing");
    // Only a shared harness candidate may name another same-case anchor as its owner;
    // app fixes always follow the consuming branch. Dispatch verifies the binding
    // through the lease callback before this lookup.
    const owner = grant.caseBinding?.candidateOwnerRunId;
    ensure(!owner || (harness && owner !== grant.agentRunId), "A case candidate binding applies only to an adopted shared harness candidate");
    // A local feature-branch source's destination is proven separately from the source, which stays unchanged.
    if (destination) await this.originRoute(source!, tested, destination);
    const pr = prSchema.parse(await this.api(candidate.repository, `pulls/${candidate.pullRequest}`));
    const base = harness ? "main" : destination?.baseBranch ?? source!.pullRequest?.baseBranch ?? source!.branch;
    // An originating PR (recorded, or the proven open origin of a local build) keeps its own branch. A newly
    // allocated case branch is exactly `codex/routine-<anchor>`, or the legacy `fix/routine-<anchor>` of frozen cases.
    const anchor = owner ?? grant.agentRunId;
    const branches = !harness && (source!.pullRequest || destination?.sourceOrigin.state === "open") ? [source!.branch]
      : [`codex/routine-${anchor}`, `fix/routine-${anchor}`];
    ensure(pr.number === candidate.pullRequest && pr.head.repo?.full_name === candidate.repository
      && pr.base.repo.full_name === candidate.repository && pr.head.sha === candidate.headSha
      && branches.includes(pr.head.ref) && pr.base.ref === base, "Candidate repository, branch, base or current head differs");
    ensure(harness || !source!.pullRequest || source!.pullRequest.number === pr.number, "Use the originating PR");
    ensure(destination?.sourceOrigin.state !== "open" || destination.sourceOrigin.pullRequest === pr.number, "Use the originating PR");
    ensure(["dev", "staging"].includes(base) || harness, "Candidate destination is not admitted");
    ensure(pr.state === "open" || pr.merged, "Candidate PR closed without merging");
    const comparison = comparisonSchema.parse(await this.api(candidate.repository, `compare/${tested}...${candidate.headSha}`));
    ensure(["ahead", "identical"].includes(comparison.status), "Candidate does not descend from the tested source");
    if (harness) {
      ensure(pr.merged && pr.merge_commit_sha && pr.merged_at, "Harness changes require review and merge before device execution");
      const ref = z.object({ ref: z.literal("refs/heads/main"), object: z.object({ type: z.literal("commit"), sha }) }).parse(
        await this.api(HARNESS, "git/ref/heads/main"));
      // GitHub includes changed-file patches only on page 1. Page 2 retains the
      // comparison status even for zero/one commits, without unrelated patches.
      const contained = comparisonSchema.parse(await this.api(HARNESS, `compare/${pr.merge_commit_sha}...${ref.object.sha}?per_page=1&page=2`));
      ensure(["ahead", "identical"].includes(contained.status), "Private main no longer contains the reviewed harness merge");
      let verification = pr;
      if (grant.harnessVerification) {
        const selected = grant.harnessVerification;
        verification = prSchema.parse(await this.api(HARNESS, `pulls/${selected.pullRequest}`));
        ensure(verification.number === selected.pullRequest && verification.head.repo?.full_name === HARNESS
          && verification.base.repo.full_name === HARNESS && verification.base.ref === "main" && verification.state === "closed"
          && verification.merged && verification.merged_at && verification.merge_commit_sha === selected.mergeCommitSha,
        "Selected harness verification PR is not the exact merged main revision");
        for (const [base, head] of [[pr.merge_commit_sha, selected.mergeCommitSha], [selected.mergeCommitSha, ref.object.sha]]) {
          const relation = comparisonSchema.parse(await this.api(HARNESS, `compare/${base}...${head}?per_page=1&page=2`));
          ensure(["ahead", "identical"].includes(relation.status), "Selected harness revision must contain the candidate merge and remain on main");
        }
        ensure(approvedVerificationHead(await this.api(HARNESS, `pulls/${selected.pullRequest}/reviews?per_page=100`), verification.head.sha),
          "Selected harness verification head requires a current approved review");
      }
      const recordedBuild = packet.build.recordedAppBuild;
      let app: Pick<ContinuationTarget, "localPublication" | "recordedBuild" | "original">;
      if (localPublication) app = { localPublication };
      else if (recordedBuild) {
        const selected = testBuildSourceSchema.parse(recordedBuild), archiveSha256 = packet.build.hashes.archiveSha256;
        ensure(packet.sourceStatus === "recorded" && packet.routine.id === routineId
          && ["dev", "staging"].includes(selected.channel) && selected.channel === source!.channel,
        "Recorded app producer must belong to this occurrence's published channel and routine");
        ensure(typeof archiveSha256 === "string" && /^[a-f0-9]{64}$/.test(archiveSha256), "The original artifact identity was not recorded");
        app = { recordedBuild: { source: selected, archiveSha256: archiveSha256! } };
      } else app = { original: this.originalRequest(packet, routineId) };
      return { query: localPublication ? { channel: localPublication.channel } : source!.channel === "pr" ? { channel: "pr", pr: source!.pullRequest!.number }
        : { channel: source!.channel as "dev" | "staging" }, expectedHeadSha: source!.headSha,
        expectedHarnessSha: verification.merge_commit_sha!, requestNotBefore: verification.merged_at!, automaticExpected: false,
        ...app };
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
  /**
   * Proves the controller's saved route for a local build of a feature branch, independently. The route belongs to the
   * branch and was proven from the tested commit it was saved for (`sourceOrigin.testedHeadSha`, the anchor's), so the
   * origin is re-proven from that immutable commit, never from a later occurrence's head: its complete association names
   * exactly one pull request from this repository's recorded branch, the signed one, still into the saved base (a
   * retarget refuses). A merged origin must have that commit as its final head, the saved merge commit, and both
   * contained in the destination. An open origin may since have merged (its candidate then follows the merged-candidate
   * path) but never closed unmerged. The consuming occurrence keeps its own exact source on that same branch; a later
   * one must continue the origin (its head descends from the origin's), and the candidate must descend from it as usual.
   */
  private async originRoute(source: NonNullable<FailurePacket["source"]>, tested: string, destination: ContinuationExecutionDestination) {
    ensure(source.channel === "local" && !source.pullRequest && source.repository === destination.repository && !["dev", "staging"].includes(source.branch),
      "An execution destination applies only to a local feature-branch source");
    const origin = destination.sourceOrigin, proven = origin.testedHeadSha;
    const listed = associatedSchema.safeParse(await this.api(PUBLIC, `commits/${proven}/pulls?per_page=100`));
    ensure(listed.success, "The originating pull request list is incomplete or invalid");
    const associated = listed.data!.filter(item => item.head.repo?.full_name === PUBLIC && item.head.ref === source.branch);
    ensure(associated.length === 1 && associated[0]!.number === origin.pullRequest, "The originating pull request is not uniquely proven");
    const pr = prSchema.parse(await this.api(PUBLIC, `pulls/${origin.pullRequest}`));
    ensure(pr.number === origin.pullRequest && pr.head.repo?.full_name === PUBLIC && pr.head.ref === source.branch
      && pr.base.repo.full_name === PUBLIC, "The originating pull request differs from the recorded source");
    ensure(pr.base.ref === destination.baseBranch, "The originating pull request was retargeted; its saved destination no longer holds");
    if (origin.state === "open") ensure(pr.state === "open" || pr.merged, "The originating pull request closed without merging");
    else {
      ensure(pr.merged && pr.head.sha === proven && pr.merge_commit_sha === origin.mergeCommitSha, "The merged originating pull request differs from the saved route");
      for (const contained of [proven, origin.mergeCommitSha])
        ensure(["ahead", "identical"].includes(comparisonSchema.parse(await this.api(PUBLIC, `compare/${contained}...${destination.baseBranch}`)).status),
          "The destination does not contain the tested source and its merge");
    }
    if (tested !== proven)
      ensure(["ahead", "identical"].includes(comparisonSchema.parse(await this.api(PUBLIC, `compare/${proven}...${tested}`)).status),
        "The consuming occurrence does not continue the saved route's origin");
  }
  /** The occurrence's own recorded source, channel, routine and artifact. Nothing is looked
   * up by branch or PR, so a newer head or another environment's build cannot substitute. */
  private original(packet: FailurePacket, grant: ContinuationGrant, candidate: ContinuationCandidate, routineId: string): ContinuationTarget {
    const source = packet.source!;
    ensure(candidate.repository === source.repository && candidate.headSha === source.headSha,
      "The original target is the occurrence's exact recorded source");
    ensure(!grant.caseBinding, "The original target belongs to its own occurrence, not a shared candidate");
    return { query: source.channel === "pr" ? { channel: "pr", pr: source.pullRequest!.number } : { channel: source.channel as "dev" | "staging" },
      expectedHeadSha: source.headSha, automaticExpected: false, original: this.originalRequest(packet, routineId) };
  }
  /** Harness verification changes the worker, never the occurrence's selected app artifact. */
  private originalRequest(packet: FailurePacket, routineId: string): NonNullable<ContinuationTarget["original"]> {
    const source = packet.source!, archiveSha256 = packet.build.hashes.archiveSha256;
    ensure(packet.routine.id === routineId, "The original target reruns only the recorded routine");
    ensure(typeof archiveSha256 === "string" && /^[a-f0-9]{64}$/.test(archiveSha256), "The original artifact identity was not recorded");
    // The trusted issuer's request that selected this exact build; its immutable artifact,
    // not the caller, later names the build run and publication attempt.
    const suffix = source.channel === "pr" ? String(source.pullRequest!.number) : source.channel;
    const request = new RegExp(`^routine-([1-9]\\d*)-1-${suffix}-${routineId}$`).exec(packet.requestId);
    ensure(request, "The original request identity was not recorded");
    return { archiveSha256: archiveSha256!, requestRunId: Number(request![1]) };
  }
}
