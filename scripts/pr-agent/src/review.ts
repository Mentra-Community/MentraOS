import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, CursorAgentError } from '@cursor/sdk';
import { loadConfig } from './config.js';
import type { PrAgentState, ReviewSlot } from './types.js';
import { execSync } from 'node:child_process';

const SLOT_PROMPT: Record<Exclude<ReviewSlot, 'bugbot'>, string> = {
  standards: 'standards-review.md',
  depth: 'depth-review.md',
};

export async function runReview(
  repoRoot: string,
  slot: Exclude<ReviewSlot, 'bugbot'>,
  prNumber: number,
  baseRef: string,
  state: PrAgentState,
): Promise<void> {
  const config = loadConfig(repoRoot);
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  const promptPath = join(repoRoot, '.github/pr-agent/prompts', SLOT_PROMPT[slot]);
  const basePrompt = readFileSync(promptPath, 'utf8');

  const diff = execSync(`git diff origin/${baseRef}...HEAD --stat`, {
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

  const context = `
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

## Changed files
${changedFiles.map((f) => `- ${f}`).join('\n')}

## Diff stat
${diff || '(no diff)'}
`;

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
