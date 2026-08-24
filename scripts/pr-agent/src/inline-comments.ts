import type { Octokit } from '@octokit/rest';
import type { Finding } from './types.js';

/**
 * Post blocking findings as inline PR review comments anchored at file/line,
 * so humans act on them where they read code instead of cross-referencing the
 * state-JSON ledger. Each comment carries a per-finding marker so re-reports
 * across cycles never duplicate. Findings that GitHub rejects (line outside
 * the diff) stay summary-only — the ledger comment already lists them.
 */

const FINDING_MARKER_PREFIX = '<!-- pr-agent-finding:';

function findingMarker(id: string): string {
  return `${FINDING_MARKER_PREFIX}${id} -->`;
}

function commentBody(finding: Finding): string {
  return `${findingMarker(finding.id)}
**PR Agent — blocking finding \`${finding.id}\`** (${finding.source})

${finding.message}

<sub>Reply \`agent-resolve ${finding.id}\` to dismiss as a false positive.</sub>`;
}

export async function postInlineFindings(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  findings: Finding[],
): Promise<void> {
  const candidates = findings.filter(
    (f) => f.severity === 'blocking' && f.file && typeof f.line === 'number' && f.line > 0,
  );
  if (candidates.length === 0) return;

  const existing: string[] = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    existing.push(...data.map((c) => c.body ?? ''));
    if (data.length < 100) break;
    page++;
  }

  const fresh = candidates.filter(
    (f) => !existing.some((body) => body.includes(findingMarker(f.id))),
  );
  if (fresh.length === 0) return;

  const comments = fresh.map((f) => ({
    path: f.file,
    line: f.line!,
    side: 'RIGHT' as const,
    body: commentBody(f),
  }));

  try {
    // One review containing every comment: a single notification for humans.
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'COMMENT',
      comments,
    });
    console.log(`Posted ${comments.length} inline finding comment(s)`);
    return;
  } catch (err) {
    // GitHub 422s the whole review when any single anchor falls outside the
    // diff. Retry per-comment so valid anchors still land.
    console.warn(
      'Batch inline review rejected; retrying per comment:',
      (err as Error).message,
    );
  }

  let posted = 0;
  for (const c of comments) {
    try {
      await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
      });
      posted++;
    } catch (err) {
      console.warn(
        `Inline comment rejected for ${c.path}:${c.line} (likely outside diff):`,
        (err as Error).message,
      );
    }
  }
  console.log(`Posted ${posted}/${comments.length} inline finding comment(s)`);
}
