import type { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import { shortId } from './findings.js';
import type { Finding } from './types.js';

/**
 * External review ingestion: external bots (Bugbot, cubic, Codex, …) post
 * native inline review comments on the PR, but those never reached the finding
 * ledger — humans had to copy/paste them for the fixer to act. This module
 * normalizes live inline comments from allowlisted bot logins into findings
 * and records which of those bots submitted a native PR review this cycle.
 */

export const EXTERNAL_SOURCE_PREFIX = 'external:';

export function isExternalSource(source: string): boolean {
  return source.startsWith(EXTERNAL_SOURCE_PREFIX);
}

export const BUGBOT_LOGIN = 'cursor[bot]';

/** Default patterns that mark an external comment as blocking (case-insensitive). */
export const DEFAULT_BLOCKING_PATTERNS = [
  '(high|critical|medium)\\s+severity',
  '\\bseverity\\s*:\\s*(high|critical|medium)\\b',
  '\\bblocking\\b',
];

export type ExternalFindings = {
  /** Findings whose underlying comments are live (still anchored to current code). */
  current: Finding[];
  /** Every external source encountered, for stale-resolution bookkeeping. */
  sources: string[];
  /**
   * Allowlisted bot logins that submitted a native PR review (or a live inline
   * comment) this cycle. Used so the bugbot slot can succeed without the
   * custom `<!-- pr-agent-bugbot-verdict -->` issue comment.
   */
  reviewers: string[];
};

function stripHtmlComments(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function emptyFindings(): ExternalFindings {
  return { current: [], sources: [], reviewers: [] };
}

async function listAllReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Awaited<ReturnType<Octokit['pulls']['listReviewComments']>>['data']> {
  const comments: Awaited<ReturnType<Octokit['pulls']['listReviewComments']>>['data'] = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    comments.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return comments;
}

async function listAllReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Awaited<ReturnType<Octokit['pulls']['listReviews']>>['data']> {
  const reviews: Awaited<ReturnType<Octokit['pulls']['listReviews']>>['data'] = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    reviews.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return reviews;
}

export async function fetchExternalFindings(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  repoRoot: string,
  cycle: number,
): Promise<ExternalFindings> {
  const ext = loadConfig(repoRoot).externalReviewers;
  if (!ext.enabled || ext.bots.length === 0) {
    return emptyFindings();
  }

  const comments = await listAllReviewComments(octokit, owner, repo, prNumber);
  const reviews = await listAllReviews(octokit, owner, repo, prNumber);

  const bots = new Set(ext.bots);
  const current: Finding[] = [];
  const sources = new Set<string>();
  const reviewers = new Set<string>();

  for (const r of reviews) {
    const login = r.user?.login ?? '';
    if (!bots.has(login)) continue;
    if ((r.state ?? '').toUpperCase() === 'PENDING') continue;
    reviewers.add(login);
    sources.add(`${EXTERNAL_SOURCE_PREFIX}${login}`);
  }

  for (const c of comments) {
    const login = c.user?.login ?? '';
    if (!bots.has(login)) continue;
    const source = `${EXTERNAL_SOURCE_PREFIX}${login}`;
    sources.add(source);

    // Thread replies are discussion, not findings.
    if (c.in_reply_to_id) continue;
    // line/position both null means GitHub marked the comment outdated: the
    // code under it changed. Treat as resolved (handled by the stale pass).
    const outdated = c.line == null && c.position == null;
    if (outdated) continue;

    const body = stripHtmlComments(c.body ?? '');
    if (!body) continue;

    // A live inline comment is itself proof the bot reviewed this cycle.
    reviewers.add(login);

    const patterns = ext.blockingPatterns[login] ?? DEFAULT_BLOCKING_PATTERNS;
    const blocking = patterns.some((p) => {
      try {
        return new RegExp(p, 'i').test(body);
      } catch {
        return false;
      }
    });

    // The comment id is a stable identity: no rewording-forks-the-fingerprint
    // failure mode, and the same comment maps to the same finding forever.
    const fingerprint = `${EXTERNAL_SOURCE_PREFIX}${login}:${c.id}`;
    current.push({
      id: shortId(fingerprint),
      fingerprint,
      source,
      severity: blocking ? 'blocking' : 'nit',
      file: c.path,
      line: c.line ?? c.original_line ?? undefined,
      message: body.slice(0, 2000),
      status: 'open',
      introducedCycle: cycle,
      lastSeenCycle: cycle,
    });
  }

  return { current, sources: [...sources], reviewers: [...reviewers] };
}
