import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ConfigSchema = z.object({
  dryRun: z.boolean().default(true),
  reviewModel: z.string().default('claude-opus-4-8'),
  fixModel: z.string().default('claude-opus-4-8'),
  /** Model for the Codex CLI reviewer slot (only used when OPENAI_API_KEY exists). */
  codexModel: z.string().default('o4-mini'),
  authors: z
    .object({
      mode: z.enum(['allowlist', 'all', 'label_only']).default('label_only'),
      allowlist: z.array(z.string()).default([]),
    })
    .default({ mode: 'label_only', allowlist: [] }),
  limits: z
    .object({
      maxFixRounds: z.number().default(5),
      maxOrchestratorCycles: z.number().default(8),
      maxBugbotWaitMin: z.number().default(12),
      maxCiWaitMin: z.number().default(45),
      maxNewBlockingPerCycle: z.number().default(5),
      maxFixAgentTurns: z.number().default(80),
      consecutiveNoNewReviewsForHandoff: z.number().default(2),
      discoveryCycles: z.number().default(1),
    })
    .default({}),
  ciGates: z
    .array(
      z.object({
        paths: z.array(z.string()),
        workflows: z.array(z.string()),
      }),
    )
    .default([]),
  /**
   * External review-bot ingestion: native inline PR review comments from these
   * bot logins are normalized into ledger findings so the fixer addresses them
   * without a human copy/pasting them into the loop.
   */
  externalReviewers: z
    .object({
      enabled: z.boolean().default(true),
      bots: z.array(z.string()).default(['cursor[bot]', 'cubic-dev-ai[bot]']),
      /**
       * Per-bot regex overrides (case-insensitive) that classify a comment as
       * blocking. Bots without an entry use the built-in defaults.
       */
      blockingPatterns: z.record(z.array(z.string())).default({}),
    })
    .default({}),
});

export type PrAgentConfig = z.infer<typeof ConfigSchema>;

let cached: PrAgentConfig | null = null;

export function loadConfig(repoRoot: string): PrAgentConfig {
  if (cached) return cached;
  const path = join(repoRoot, '.github/pr-agent.yml');
  const raw = parse(readFileSync(path, 'utf8'));
  cached = ConfigSchema.parse(raw);
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
