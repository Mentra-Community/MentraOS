import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldBlankPrForWorkflowRunHandoff } from '../src/handoff-gate.js';
import { repoRoot } from './helpers.js';

const workflowPath = join(
  repoRoot,
  '.github/workflows/pr-agent-orchestrator.yml',
);

/** Slice from `  jobId:` through the line before the next 2-space job key. */
function jobBlock(workflow: string, jobId: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start < 0) throw new Error(`job ${jobId} not found in workflow`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z][a-z0-9_-]*:$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('workflow cancelled-Plan guards', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  for (const jobId of [
    'aggregate',
    'wait-ci',
    'recheck-handoff',
    'finalize',
  ] as const) {
    test(`${jobId} requires needs.plan.result == 'success'`, () => {
      const block = jobBlock(workflow, jobId);
      // Empty should_skip after a cancelled Plan used to evaluate as != 'true'
      // and revive Aggregate/Finalize — plan.result success is the real gate.
      expect(block).toContain("needs.plan.result == 'success'");
    });
  }

  test('resolve-context blanks pr_number for handoff on workflow_run', () => {
    expect(workflow).toContain("context.eventName === 'workflow_run'");
    expect(workflow).toContain("ready-for-human-review");
    expect(workflow).toContain('agent-resume');
    // After resolving the PR, handoff-without-resume blanks pr_number.
    expect(workflow).toMatch(
      /hasHandoff && !hasResume[\s\S]*?core\.setOutput\('pr_number', ''\)/,
    );
  });
});

describe('shouldBlankPrForWorkflowRunHandoff', () => {
  test('blanks workflow_run when ready-for-human-review and no agent-resume', () => {
    expect(
      shouldBlankPrForWorkflowRunHandoff('workflow_run', [
        'ready-for-human-review',
        'agent-needs-human',
      ]),
    ).toBe(true);
  });

  test('does not blank when agent-resume is present', () => {
    expect(
      shouldBlankPrForWorkflowRunHandoff('workflow_run', [
        'ready-for-human-review',
        'agent-resume',
      ]),
    ).toBe(false);
  });

  test('never blanks pull_request events for this reason', () => {
    expect(
      shouldBlankPrForWorkflowRunHandoff('pull_request', [
        'ready-for-human-review',
      ]),
    ).toBe(false);
  });

  test('does not blank workflow_run without handoff label', () => {
    expect(
      shouldBlankPrForWorkflowRunHandoff('workflow_run', ['agent-in-progress']),
    ).toBe(false);
  });
});
