import { Octokit } from '@octokit/rest';
import {
  MARKER_ORCHESTRATOR,
  PrAgentStateSchema,
  type PrAgentState,
} from './types.js';

export function createOctokit(token?: string): Octokit {
  const auth = token ?? process.env.GITHUB_TOKEN ?? process.env.PR_AGENT_GITHUB_TOKEN;
  if (!auth) {
    throw new Error('GITHUB_TOKEN or PR_AGENT_GITHUB_TOKEN required');
  }
  return new Octokit({ auth });
}

export async function listAllIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Array<{ id: number; body?: string | null; created_at?: string | null }>> {
  const all: Array<{ id: number; body?: string | null; created_at?: string | null }> = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

export function parseStateFromComment(body: string): PrAgentState | null {
  if (!body.includes(MARKER_ORCHESTRATOR)) return null;
  const jsonMatch = body.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) return null;
  try {
    return PrAgentStateSchema.parse(JSON.parse(jsonMatch[1]!));
  } catch {
    return null;
  }
}

export function formatStateComment(state: PrAgentState): string {
  return `${MARKER_ORCHESTRATOR}
## PR Agent Orchestrator State

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
`;
}

export function defaultState(): PrAgentState {
  return PrAgentStateSchema.parse({});
}

export async function loadOrCreateState(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ state: PrAgentState; commentId?: number }> {
  // Races between concurrent orchestrator runs (e.g. a workflow_run-triggered
  // run on the default branch overlapping a pull_request-triggered run on the
  // PR branch) have produced duplicate state comments: a transient list/parse
  // failure made one run fall back to a default state, whose save then created
  // a second marker comment. Recover deterministically: parse every marker
  // comment, adopt the highest revision, and best-effort delete the rest so
  // the ledger converges back to a single source of truth.
  for (let attempt = 0; attempt < 2; attempt++) {
    const comments = await listAllIssueComments(octokit, owner, repo, issueNumber);
    const markers = comments.filter((c) => c.body?.includes(MARKER_ORCHESTRATOR));

    const parsed = markers
      .map((c) => ({ id: c.id, state: c.body ? parseStateFromComment(c.body) : null }))
      .filter((x): x is { id: number; state: PrAgentState } => x.state != null);

    if (parsed.length > 0) {
      parsed.sort((a, b) => (b.state.revision ?? 0) - (a.state.revision ?? 0));
      const winner = parsed[0]!;
      for (const dup of parsed.slice(1)) {
        try {
          await octokit.issues.deleteComment({ owner, repo, comment_id: dup.id });
          console.log(
            `Deleted duplicate state comment ${dup.id} (revision ${dup.state.revision ?? 0} < ${winner.state.revision ?? 0})`,
          );
        } catch {
          // Best-effort: a leftover duplicate is inert as long as the winner sorts first.
        }
      }
      return { state: winner.state, commentId: winner.id };
    }

    if (markers.length > 0 && attempt === 0) {
      // Marker comments exist but none parsed — likely a transient mid-edit
      // read. Retry once before falling back: proceeding with a default state
      // silently resets the ledger and budget counters.
      console.warn('State comment present but unparseable; retrying once before default');
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    break;
  }
  return { state: defaultState() };
}

export async function saveState(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  state: PrAgentState,
  commentId?: number,
): Promise<{ wrote: boolean; revision: number }> {
  const localRevision = state.revision ?? 0;

  if (commentId) {
    // Compare-and-swap: refuse to overwrite a newer revision written by a
    // concurrent orchestrator run (the #3465 lost-update failure mode).
    try {
      const { data } = await octokit.issues.getComment({
        owner,
        repo,
        comment_id: commentId,
      });
      const remote = data.body ? parseStateFromComment(data.body) : null;
      const remoteRevision = remote?.revision ?? 0;
      if (remote && remoteRevision > localRevision) {
        console.log(
          `Skipping stale state write: local revision ${localRevision} < remote ${remoteRevision}`,
        );
        return { wrote: false, revision: remoteRevision };
      }
    } catch (err) {
      console.warn('saveState: failed to re-read state comment before write', err);
    }
  }

  const nextRevision = localRevision + 1;
  const nextState: PrAgentState = { ...state, revision: nextRevision };
  const body = formatStateComment(nextState);

  if (commentId) {
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
    return { wrote: true, revision: nextRevision };
  }
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return { wrote: true, revision: nextRevision };
}

export async function upsertMarkerComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  const comments = await listAllIssueComments(octokit, owner, repo, issueNumber);
  const existing = comments.find((c) => c.body?.includes(marker));
  if (existing) {
    await octokit.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return;
  }
  await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

export async function prHasLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<boolean> {
  const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
  return (data.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === label);
}

export async function ensureLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  const has = await prHasLabel(octokit, owner, repo, issueNumber, label);
  if (!has) {
    await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [label] });
  }
}

export async function removeLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
  } catch {
    // label may not exist
  }
}
