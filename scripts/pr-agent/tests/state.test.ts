import { describe, expect, test } from 'bun:test';
import {
  formatStateComment,
  parseStateFromComment,
  saveState,
} from '../src/state.js';
import { makeState } from './helpers.js';

describe('saveState revision CAS', () => {
  test('refuses to overwrite a newer remote revision', async () => {
    const remote = makeState({
      cycle: 25,
      totalReviewerRuns: 31,
      revision: 7,
    });
    const local = makeState({
      cycle: 2,
      totalReviewerRuns: 2,
      revision: 5,
    });

    let updated: string | null = null;
    const octokit = {
      issues: {
        getComment: async () => ({
          data: { id: 99, body: formatStateComment(remote) },
        }),
        updateComment: async (args: { body: string }) => {
          updated = args.body;
          return { data: { id: 99, body: args.body } };
        },
        createComment: async () => {
          throw new Error('should not create');
        },
      },
    } as any;

    const result = await saveState(octokit, 'o', 'r', 1, local, 99);

    expect(result.wrote).toBe(false);
    expect(result.revision).toBe(7);
    expect(updated).toBeNull();
  });

  test('writes when local revision is ahead of remote', async () => {
    const remote = makeState({
      cycle: 10,
      totalReviewerRuns: 10,
      revision: 7,
    });
    const local = makeState({
      cycle: 11,
      totalReviewerRuns: 11,
      revision: 8,
    });

    let updatedBody = '';
    const octokit = {
      issues: {
        getComment: async () => ({
          data: { id: 99, body: formatStateComment(remote) },
        }),
        updateComment: async (args: { body: string }) => {
          updatedBody = args.body;
          return { data: { id: 99, body: args.body } };
        },
      },
    } as any;

    const result = await saveState(octokit, 'o', 'r', 1, local, 99);

    expect(result.wrote).toBe(true);
    expect(result.revision).toBe(9);
    const parsed = parseStateFromComment(updatedBody);
    expect(parsed?.revision).toBe(9);
    expect(parsed?.cycle).toBe(11);
    expect(parsed?.totalReviewerRuns).toBe(11);
  });

  test('stale concurrent writer cannot regress cycle/totalReviewerRuns (#3465)', async () => {
    // Simulate: remote already advanced to cycle 25 / revision 20;
    // a cancelled run still holding revision 2 tries to write cycle 3.
    let remoteBody = formatStateComment(
      makeState({ cycle: 25, totalReviewerRuns: 31, revision: 20 }),
    );

    const staleLocal = makeState({
      cycle: 3,
      totalReviewerRuns: 3,
      revision: 2,
    });

    const octokit = {
      issues: {
        getComment: async () => ({
          data: { id: 1, body: remoteBody },
        }),
        updateComment: async (args: { body: string }) => {
          remoteBody = args.body;
          return { data: { id: 1, body: args.body } };
        },
      },
    } as any;

    const result = await saveState(octokit, 'o', 'r', 3465, staleLocal, 1);
    expect(result.wrote).toBe(false);

    const still = parseStateFromComment(remoteBody);
    expect(still?.cycle).toBe(25);
    expect(still?.totalReviewerRuns).toBe(31);
    expect(still?.revision).toBe(20);
  });
});
