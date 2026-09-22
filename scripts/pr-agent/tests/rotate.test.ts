/**
 * Slot-selection tests: which diffs Bugbot will actually review, and what
 * stands in for it when it will not. Run with `bun test`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  isBugbotReviewable,
  resolveActivePair,
  substituteBugbotSlot,
} from '../src/rotate.js';
import { makeState } from './helpers.js';

beforeEach(() => {
  delete process.env.HAS_OPENAI_API_KEY;
});

describe('isBugbotReviewable', () => {
  test('prose-only diffs are not reviewable', () => {
    expect(
      isBugbotReviewable([
        'notes/superpowers/plans/2026-08-28-enterprise-acs-guest-routing.md',
        'notes/superpowers/specs/2026-08-28-enterprise-acs-guest-routing-design.md',
      ]),
    ).toBe(false);
    expect(isBugbotReviewable(['mintlify-docs/app-devs/quickstart.mdx'])).toBe(false);
    expect(isBugbotReviewable(['README.md', 'CHANGELOG.txt'])).toBe(false);
  });

  test('any code file makes the diff reviewable', () => {
    expect(isBugbotReviewable(['README.md', 'scripts/pr-agent/src/plan.ts'])).toBe(true);
    expect(
      isBugbotReviewable(['asg_client/app/src/main/java/com/mentra/Foo.java']),
    ).toBe(true);
  });

  test('a code file under a docs directory still counts as code', () => {
    expect(isBugbotReviewable(['mintlify-docs/snippets/example.ts'])).toBe(true);
  });

  test('an empty diff is not reviewable', () => {
    expect(isBugbotReviewable([])).toBe(false);
  });
});

describe('substituteBugbotSlot', () => {
  test('keeps two distinct model slots when bugbot is dropped', () => {
    expect(substituteBugbotSlot(['bugbot', 'standards'], false)).toEqual([
      'standards',
      'depth',
    ]);
    expect(substituteBugbotSlot(['bugbot', 'depth'], false)).toEqual([
      'depth',
      'standards',
    ]);
  });

  test('prefers codex only when the slot is available', () => {
    expect(substituteBugbotSlot(['bugbot', 'depth'], true)).toEqual([
      'depth',
      'standards',
    ]);
    // depth and standards both taken: codex is the only remaining option.
    expect(substituteBugbotSlot(['bugbot', 'depth', 'standards'], true)).toEqual([
      'depth',
      'standards',
      'codex',
    ]);
    expect(substituteBugbotSlot(['bugbot', 'depth', 'standards'], false)).toEqual([
      'depth',
      'standards',
    ]);
  });

  test('pairs without bugbot pass through untouched', () => {
    expect(substituteBugbotSlot(['standards', 'depth'], false)).toEqual([
      'standards',
      'depth',
    ]);
  });

  test('substituted pairs are always two independent reviewers', () => {
    for (let cycle = 0; cycle < 6; cycle++) {
      const pair = resolveActivePair(makeState({ cycle }), true, false);
      if (!pair.includes('bugbot')) continue;
      const substituted = substituteBugbotSlot(pair, false);
      expect(substituted).not.toContain('bugbot');
      expect(new Set(substituted).size).toBe(2);
    }
  });
});
