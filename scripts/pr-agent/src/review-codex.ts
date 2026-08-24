import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { buildReviewContext } from './review.js';
import type { PrAgentState } from './types.js';

/**
 * Codex CLI reviewer: a true third-vendor slot (OpenAI, not Cursor-billed).
 * Two prompts on one model are not two independent reviewers — Codex has
 * previously caught bugs both Claude slots missed. Runs `codex exec` headless
 * in read-only sandbox mode and writes the same review-<slot>.txt contract the
 * aggregate step already consumes.
 */
export async function runCodexReview(
  repoRoot: string,
  prNumber: number,
  baseRef: string,
  state: PrAgentState,
): Promise<void> {
  const config = loadConfig(repoRoot);
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for the codex review slot');
  }

  const promptPath = join(repoRoot, '.github/pr-agent/prompts/codex-review.md');
  const basePrompt = readFileSync(promptPath, 'utf8');
  const context = buildReviewContext(repoRoot, prNumber, baseRef, state);
  const fullPrompt = `${basePrompt}\n\n---\n\n${context}`;

  const outDir = join(repoRoot, '.pr-agent');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'review-codex.txt');

  const model = process.env.PR_AGENT_CODEX_MODEL ?? config.codexModel;

  // Prompt goes via stdin ("-"): it embeds a full unified diff and can exceed
  // the kernel's per-argument size limit as an argv entry.
  execFileSync(
    'codex',
    [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-m',
      model,
      '--output-last-message',
      outPath,
      '-',
    ],
    {
      cwd: repoRoot,
      input: fullPrompt,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 20 * 60_000,
    },
  );

  if (!existsSync(outPath)) {
    // Aggregate treats a missing artifact as "slot did not run"; an empty file
    // means "ran but produced no verdict" — either way the cycle stays safe.
    writeFileSync(outPath, '', 'utf8');
  }
  console.log('Review codex complete.');
}
