import { join } from 'node:path';
import { PrAgentStateSchema, type PrAgentState } from '../src/types.js';
import type { CiCheckStatus } from '../src/ci-gates.js';

/** Monorepo root (parent of scripts/pr-agent). */
export const repoRoot = join(import.meta.dir, '../../..');

export function makeState(overrides: Partial<PrAgentState> = {}): PrAgentState {
  return PrAgentStateSchema.parse(overrides);
}

export function ciFailedChecks(
  name = 'Mobile App Quality Checks',
): CiCheckStatus[] {
  return [
    {
      name,
      status: 'completed',
      conclusion: 'failure',
      required: true,
    },
  ];
}

export function ciGreenChecks(
  name = 'Mobile App Quality Checks',
): CiCheckStatus[] {
  return [
    {
      name,
      status: 'completed',
      conclusion: 'success',
      required: true,
    },
  ];
}

export function ciPendingChecks(
  name = 'Mobile App Quality Checks',
): CiCheckStatus[] {
  return [
    {
      name,
      status: 'in_progress',
      conclusion: null,
      required: true,
    },
  ];
}
