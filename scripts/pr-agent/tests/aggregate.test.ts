import { afterEach, describe, expect, test } from 'bun:test';
import { aggregateCycle } from '../src/aggregate.js';
import { resetConfigCache } from '../src/config.js';
import {
  ciFailedChecks,
  ciGreenChecks,
  makeState,
  repoRoot,
} from './helpers.js';

afterEach(() => {
  delete process.env.CI_TRIGGER_FAILED;
  resetConfigCache();
});

describe('aggregateCycle cycle-cap vs CI-red fixer budget', () => {
  test('does not hand off when cycle>=max, CI failed, and fix rounds remain', () => {
    const state = makeState({
      cycle: 8,
      fixRound: 4,
      status: 'in_progress',
      consecutiveNoNewReviews: 0,
    });

    const result = aggregateCycle(
      repoRoot,
      state,
      {},
      ciFailedChecks(),
      [],
    );

    expect(result.ciFailed).toBe(true);
    expect(result.shouldHandoff).toBe(false);
    expect(result.shouldFix).toBe(true);
    expect(result.state.status).toBe('in_progress');
    expect(result.handoffReason).toBeUndefined();
  });

  test('hands off budget_exhausted when cycle>=max, CI failed, but fix rounds exhausted', () => {
    const state = makeState({
      cycle: 8,
      fixRound: 5,
      status: 'in_progress',
    });

    const result = aggregateCycle(
      repoRoot,
      state,
      {},
      ciFailedChecks(),
      [],
    );

    expect(result.ciFailed).toBe(true);
    expect(result.shouldHandoff).toBe(true);
    expect(result.shouldFix).toBe(false);
    expect(result.handoffReason).toBe('budget_exhausted');
    expect(result.state.status).toBe('budget_exhausted');
  });

  test('still hands off budget_exhausted when cycle>=max and CI is green', () => {
    const state = makeState({
      cycle: 8,
      fixRound: 1,
      status: 'in_progress',
      consecutiveNoNewReviews: 0,
    });

    const result = aggregateCycle(
      repoRoot,
      state,
      {},
      ciGreenChecks(),
      [],
    );

    expect(result.ciFailed).toBe(false);
    expect(result.shouldHandoff).toBe(true);
    expect(result.shouldFix).toBe(false);
    expect(result.handoffReason).toBe('budget_exhausted');
  });

  test('honors CI_TRIGGER_FAILED env even when check list looks green', () => {
    process.env.CI_TRIGGER_FAILED = 'true';
    const state = makeState({
      cycle: 8,
      fixRound: 2,
      status: 'in_progress',
    });

    const result = aggregateCycle(
      repoRoot,
      state,
      {},
      ciGreenChecks(),
      [],
    );

    expect(result.ciFailed).toBe(true);
    expect(result.shouldHandoff).toBe(false);
    expect(result.shouldFix).toBe(true);
  });
});
