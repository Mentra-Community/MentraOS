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
  const config = loadConfig(repoRoot);
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  if (config.dryRun) {
    console.log('[DRY_RUN] Skipping fixer commit/push');
    return { ran: false, committed: false };
  }

  const promptPath = join(repoRoot, '.github/pr-agent/prompts/pr-fix.md');
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

  try {
    await using agent = await Agent.create({
      apiKey,
      model: { id: fixModel },
      local: { cwd: repoRoot, settingSources: [] },
    });

    let assistantTurns = 0;
    let cancelledForTurns = false;
    let activeRun: Run | undefined;

    const run = await agent.send(`${basePrompt}\n\n---\n\n${context}`, {
      onStep: async ({ step }) => {
        if (step.type !== 'assistantMessage') return;
        assistantTurns += 1;
        if (assistantTurns >= maxTurns && !cancelledForTurns && activeRun) {
          cancelledForTurns = true;
          console.warn(
            `Fixer hit maxFixAgentTurns (${maxTurns}); cancelling run to commit progress.`,
          );
          try {
            await activeRun?.cancel();
          } catch (e) {
            console.warn('Run cancel failed:', (e as Error).message);
          }
        }
      },
    });
    activeRun = run;
    console.log('Fix agent run id:', run.id);

    const result = await run.wait();
    if (result.status === 'error') {
      console.error('Fix run failed:', result.id);
      process.exit(2);
    }
    if (cancelledForTurns) {
      console.warn(`Fixer stopped after ${assistantTurns} turns (cap ${maxTurns}).`);
    }

    console.log(result.result?.slice(0, 2000) ?? '(no text)');

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
    throw err;
  }
}
