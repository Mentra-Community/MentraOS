import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent, CursorAgentError, type Run } from '@cursor/sdk';
import { loadConfig } from './config.js';
import type { Finding, PrAgentState } from './types.js';
import { openBlocking } from './findings.js';

export type FixResult = {
  /** Whether the fixer agent actually executed a turn (counts toward fix rounds). */
  ran: boolean;
  /** Whether the fixer produced and pushed a commit. */
  committed: boolean;
};

export async function runFix(
  repoRoot: string,
  state: PrAgentState,
  ciLogExcerpt: string,
): Promise<FixResult> {
  // Tooling (config + prompts) may be pinned to the PR base in a sibling
  // checkout. Git operations stay on the PR working tree (`repoRoot`).
  const toolRoot = process.env.PR_AGENT_TOOL_ROOT ?? repoRoot;
  const config = loadConfig(toolRoot);
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  if (config.dryRun) {
    console.log('[DRY_RUN] Skipping fixer commit/push');
    return { ran: false, committed: false };
  }

  const promptPath = join(toolRoot, '.github/pr-agent/prompts/pr-fix.md');
  const basePrompt = readFileSync(promptPath, 'utf8');

  const blocking = openBlocking(state.openFindings);
  const context = `
## Fix round ${state.fixRound + 1}

## Open blocking findings
\`\`\`json
${JSON.stringify(blocking, null, 2)}
\`\`\`

## CI logs (excerpt)
${ciLogExcerpt || '(none)'}

Apply fixes in the working tree. Run relevant tests before finishing.
`;

  const fixModel = process.env.PR_AGENT_FIX_MODEL ?? config.fixModel;
  const maxTurns = config.limits.maxFixAgentTurns;

  let runId: string | undefined;

  try {
    await using agent = await Agent.create({
      apiKey,
      model: { id: fixModel },
      local: { cwd: repoRoot, settingSources: [] },
    });

    let assistantTurns = 0;
    let cancelledForTurns = false;
    // Mutable cell so the onStep closure can cancel even before agent.send returns.
    const runRef: { current: Run | undefined } = { current: undefined };

    const run = await agent.send(`${basePrompt}\n\n---\n\n${context}`, {
      onStep: async ({ step }) => {
        if (step.type !== 'assistantMessage') return;
        assistantTurns += 1;
        if (assistantTurns >= maxTurns && !cancelledForTurns) {
          cancelledForTurns = true;
          console.warn(
            `Fixer hit maxFixAgentTurns (${maxTurns}); cancelling run to commit progress.`,
          );
          try {
            await runRef.current?.cancel();
          } catch (e) {
            console.warn('Run cancel failed:', (e as Error).message);
          }
        }
      },
    });
    runRef.current = run;
    runId = run.id;
    console.log('Fix agent run id:', runId);

    let result: Awaited<ReturnType<Run['wait']>> | undefined;
    try {
      result = await run.wait();
    } catch (waitErr) {
      console.error('run.wait() threw:', (waitErr as Error).message ?? waitErr);
      // Fall through to commit whatever partial changes the agent made.
    }

    if (result?.status === 'error') {
      console.error('Fix run returned error status:', runId);
      // Fall through — still try to commit any partial changes.
    } else if (cancelledForTurns) {
      console.warn(`Fixer stopped after ${assistantTurns} turns (cap ${maxTurns}).`);
    } else if (result) {
      console.log(result.result?.slice(0, 2000) ?? '(no text)');
    }

    const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' });
    if (!status.trim()) {
      console.log('No file changes from fixer');
      return { ran: true, committed: false };
    }

    execSync('git config user.name "github-actions[bot]"', { cwd: repoRoot });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', {
      cwd: repoRoot,
    });
    execSync('git add -A', { cwd: repoRoot });
    execSync(
      `git commit -m "fix(pr-agent): round ${state.fixRound + 1} [pr-agent-fix]"`,
      { cwd: repoRoot },
    );
    const headRef = process.env.PR_HEAD_REF;
    if (!headRef) {
      throw new Error('PR_HEAD_REF is required to push fix commits to the PR branch');
    }
    execSync(`git push origin HEAD:refs/heads/${headRef}`, { cwd: repoRoot });
    console.log('Pushed fix commit');
    return { ran: true, committed: true };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error('Fix startup failed:', err.message);
      process.exit(1);
    }
    console.error('Fix agent unexpected error (run', runId ?? 'unknown', '):', (err as Error).message ?? err);
    // Non-fatal: mark as ran but not committed so the orchestrator records a fix round.
    process.exit(2);
  }
}
