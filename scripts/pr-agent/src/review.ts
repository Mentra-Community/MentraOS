import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, CursorAgentError } from '@cursor/sdk';
import { loadConfig } from './config.js';
import type { PrAgentState } from './types.js';
import { execSync } from 'node:child_process';

const SLOT_PROMPT: Record<'standards' | 'depth', string> = {
  standards: 'standards-review.md',
  depth: 'depth-review.md',
};

/**
 * Shared review context (diff, changed files, orchestrator state, how-to)
 * used by both the Cursor SDK reviewers and the Codex CLI reviewer so every
 * slot judges the same evidence.
 */
export function buildReviewContext(
  repoRoot: string,
  prNumber: number,
  baseRef: string,
  state: PrAgentState,
): string {
  const diffStat = execSync(`git diff origin/${baseRef}...HEAD --stat`, {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  const changedFiles = execSync(`git diff --name-only origin/${baseRef}...HEAD`, {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);

  // Feed the actual unified diff, not just the stat, so the reviewer can see
  // the real code changes. Cap the size so a huge PR cannot blow the context
  // window; when truncated the agent is told to read the files directly.
  const MAX_DIFF_CHARS = 180_000;
  const fullDiff = execSync(`git diff origin/${baseRef}...HEAD`, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const diffTruncated = fullDiff.length > MAX_DIFF_CHARS;
  const diffBody = diffTruncated
    ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated at ${MAX_DIFF_CHARS} chars — open the changed files directly to review the rest] ...`
    : fullDiff || '(no diff)';

  return `
PR #${prNumber}
Base: ${baseRef}

## Orchestrator state
\`\`\`json
${JSON.stringify(
  {
    openFindings: state.openFindings,
    resolvedFindings: state.resolvedFindings,
    phase: state.phase,
    cycle: state.cycle,
  },
  null,
  2,
)}
\`\`\`

## How to review
You are running inside a checkout of this PR's HEAD at \`${repoRoot}\`. The full
diff is below, but it only shows the changed lines. For anything non-trivial,
**open the changed files and the symbols they touch** (constructors, factories,
callers, callees, lifecycle hooks) to understand runtime behavior across files —
do not review from the diff hunks alone.

## Changed files
${changedFiles.map((f) => `- ${f}`).join('\n')}

## Diff stat
${diffStat || '(no diff)'}

## Diff
\`\`\`diff
${diffBody}
\`\`\`
`;
}

export async function runReview(
  repoRoot: string,
  slot: 'standards' | 'depth',
  prNumber: number,
  baseRef: string,
  state: PrAgentState,
): Promise<void> {
  const config = loadConfig(repoRoot);
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  const promptPath = join(repoRoot, '.github/pr-agent/prompts', SLOT_PROMPT[slot]);
  const basePrompt = readFileSync(promptPath, 'utf8');

  const context = buildReviewContext(repoRoot, prNumber, baseRef, state);
  const fullPrompt = `${basePrompt}\n\n---\n\n${context}`;

  const reviewModel =
    process.env.PR_AGENT_REVIEW_MODEL ?? config.reviewModel;

  try {
    const result = await Agent.prompt(fullPrompt, {
      apiKey,
      model: { id: reviewModel },
      local: { cwd: repoRoot, settingSources: [] },
    });

    if (result.status === 'error') {
      console.error('Review run failed:', result.id);
      process.exit(2);
    }

    const outDir = join(repoRoot, '.pr-agent');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `review-${slot}.txt`), result.result ?? '', 'utf8');
    console.log(`Review ${slot} complete. agent run: ${result.id}`);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error('Review startup failed:', err.message, 'retryable=', err.isRetryable);
      process.exit(1);
    }
    throw err;
  }
}
