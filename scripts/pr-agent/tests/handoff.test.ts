import { describe, expect, test } from 'bun:test';
import { buildHandoffComment } from '../src/handoff.js';
import { MARKER_HANDOFF } from '../src/types.js';
import { upsertMarkerComment } from '../src/state.js';
import {
  ciFailedChecks,
  ciGreenChecks,
  makeState,
} from './helpers.js';

describe('buildHandoffComment', () => {
  test('always includes MARKER_HANDOFF', () => {
    const body = buildHandoffComment(
      'budget_exhausted',
      makeState({ cycle: 8, fixRound: 1 }),
      ciGreenChecks(),
    );
    expect(body.startsWith(MARKER_HANDOFF)).toBe(true);
  });

  test('states CI failure plainly when checks are red', () => {
    const body = buildHandoffComment(
      'budget_exhausted',
      makeState({ cycle: 9, fixRound: 4 }),
      ciFailedChecks(),
    );
    expect(body).toContain('Path-scoped CI is failing');
    expect(body).toContain('**CI is failing.**');
    expect(body).not.toContain('**Humans merge when ready.**');
  });

  test('keeps clean merge-ready footer when CI is green', () => {
    const body = buildHandoffComment(
      'human_handoff',
      makeState({ cycle: 4, fixRound: 0, consecutiveNoNewReviews: 2 }),
      ciGreenChecks(),
    );
    expect(body).toContain('Clean handoff');
    expect(body).toContain('**Humans merge when ready.**');
    expect(body).not.toContain('**CI is failing.**');
  });
});

describe('upsertMarkerComment handoff spam fix', () => {
  test('second upsert updates existing comment instead of creating another', async () => {
    const createCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    let storedBody: string | null = null;

    const octokit = {
      issues: {
        listComments: async () => ({
          data: storedBody
            ? [{ id: 42, body: storedBody }]
            : [],
        }),
        createComment: async (args: { body: string }) => {
          createCalls.push(args);
          storedBody = args.body;
          return { data: { id: 42, body: args.body } };
        },
        updateComment: async (args: { comment_id: number; body: string }) => {
          updateCalls.push(args);
          storedBody = args.body;
          return { data: { id: args.comment_id, body: args.body } };
        },
      },
    } as any;

    const first = buildHandoffComment(
      'budget_exhausted',
      makeState({ cycle: 8 }),
      ciFailedChecks(),
    );
    await upsertMarkerComment(octokit, 'o', 'r', 1, MARKER_HANDOFF, first);

    const second = buildHandoffComment(
      'budget_exhausted',
      makeState({ cycle: 9 }),
      ciFailedChecks(),
    );
    await upsertMarkerComment(octokit, 'o', 'r', 1, MARKER_HANDOFF, second);

    expect(createCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as { comment_id: number }).comment_id).toBe(42);
    expect(storedBody).toContain('Review cycles | 9');
  });
});
