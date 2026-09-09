import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requiredWorkflowsForPaths } from '../src/ci-gates.js';
import { shouldBlankPrForWorkflowRunHandoff } from '../src/handoff-gate.js';
import { repoRoot } from './helpers.js';

const workflowPath = join(
  repoRoot,
  '.github/workflows/pr-agent-orchestrator.yml',
);
const ciGateWorkflowPath = join(repoRoot, '.github/workflows/ci-gate.yml');

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

describe('CI Gate empty-area handling', () => {
  const workflow = readFileSync(ciGateWorkflowPath, 'utf8');

  test('settles successfully after grace when no gated workflow registers', () => {
    expect(workflow).toContain(
      'else if (elapsedMs >= GRACE_MS || alreadySettled)',
    );
    expect(workflow).toContain(
      'const EMPTY_AREA_DESCRIPTION = "No required area builds for this change"',
    );
    expect(workflow).toContain(
      'latest?.description !== EMPTY_AREA_DESCRIPTION',
    );
    expect(workflow).toContain('description = EMPTY_AREA_DESCRIPTION');
  });
});

describe('Cloud V2 validation gate paths', () => {
  test('requires validation when its workflow definition changes', () => {
    expect(
      requiredWorkflowsForPaths(
        ['.github/workflows/cloud-v2-validation.yml'],
        repoRoot,
      ),
    ).toContain('Cloud V2 Validation');
  });
});

describe('workflow tooling pin', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  test('tool_ref dispatch input and resolve-context output exist', () => {
    expect(workflow).toContain('tool_ref:');
    expect(workflow).toContain("core.setOutput('tool_ref'");
    expect(workflow).toContain('github.event.inputs.tool_ref');
  });

  for (const jobId of [
    'plan',
    'aggregate',
    'wait-ci',
    'recheck-handoff',
    'finalize',
    'review-bugbot',
  ] as const) {
    test(`${jobId} checks out tool_ref`, () => {
      expect(jobBlock(workflow, jobId)).toContain(
        'needs.resolve-context.outputs.tool_ref',
      );
    });
  }

  for (const jobId of ['review-standards', 'review-depth', 'review-codex'] as const) {
    test(`${jobId} overlays tooling from tool_ref onto PR HEAD`, () => {
      const block = jobBlock(workflow, jobId);
      expect(block).toContain('head_sha');
      expect(block).toContain('Pin orchestrator tooling to base');
      expect(block).toContain('needs.resolve-context.outputs.tool_ref');
    });
  }

  test('fix job uses a sibling tool checkout hidden from git add -A', () => {
    const block = jobBlock(workflow, 'fix');
    expect(block).toContain('.pr-agent-tool');
    expect(block).toContain('PR_AGENT_TOOL_ROOT');
    expect(block).toContain('.git/info/exclude');
    expect(block).toContain('head_ref');
  });
});

describe('continue-loop self-dispatch guards (#3851)', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  test('workflow can dispatch itself', () => {
    // createWorkflowDispatch needs actions: write; read-only strands the loop.
    expect(workflow).toMatch(/permissions:[\s\S]*?actions: write/);
  });

  test('continue-loop is gated on a real plan and an explicit continuation ask', () => {
    const block = jobBlock(workflow, 'continue-loop');
    expect(block).toContain("needs.plan.result == 'success'");
    expect(block).toContain("needs.aggregate.outputs.needs_continuation == 'true'");
    expect(block).toContain(
      "needs.recheck-handoff.outputs.needs_continuation == 'true'",
    );
    expect(block).toContain('bun run cli continue');
  });

  test('continue-loop can never race a handoff', () => {
    const block = jobBlock(workflow, 'continue-loop');
    expect(block).toContain("needs.plan.outputs.should_handoff != 'true'");
    expect(block).toContain("needs.aggregate.outputs.should_handoff != 'true'");
    expect(block).toContain("needs.recheck-handoff.outputs.should_handoff != 'true'");
    expect(block).toContain("needs.finalize.result == 'skipped'");
  });

  test('continuation signals are exported by both deciding jobs', () => {
    expect(jobBlock(workflow, 'aggregate')).toContain(
      'needs_continuation: ${{ steps.agg.outputs.needs_continuation }}',
    );
    expect(jobBlock(workflow, 'recheck-handoff')).toContain(
      'needs_continuation: ${{ steps.recheck.outputs.needs_continuation }}',
    );
  });

  test('BUGBOT_STARTED is passed through without a false default', () => {
    // A blank value must stay blank: it means "unknown", not "did not start".
    expect(jobBlock(workflow, 'review-bugbot')).toContain(
      'bugbot_started: ${{ steps.poll.outputs.bugbot_started }}',
    );
    expect(jobBlock(workflow, 'aggregate')).toContain(
      'BUGBOT_STARTED: ${{ needs.review-bugbot.outputs.bugbot_started }}',
    );
  });
});
