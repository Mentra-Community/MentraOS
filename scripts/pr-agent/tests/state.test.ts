import { describe, expect, test } from 'bun:test';
import {
  formatStateComment,
  loadOrCreateState,
  parseStateFromComment,
  saveState,
} from '../src/state.js';
import { makeState } from './helpers.js';

describe('loadOrCreateState duplicate recovery', () => {
  test('adopts the highest-revision state comment and deletes duplicates', async () => {
    const real = formatStateComment(makeState({ cycle: 3, revision: 12 }));
    const rogue = formatStateComment(makeState({ cycle: 0, revision: 1 }));
    const deleted: number[] = [];
    const octokit = {
      issues: {
        listComments: async ({ page }: { page: number }) => ({
          data:
            page === 1
              ? [
                  { id: 1, body: 'unrelated' },
                  { id: 2, body: real },
                  { id: 3, body: rogue },
                ]
              : [],
        }),
        deleteComment: async ({ comment_id }: { comment_id: number }) => {
          deleted.push(comment_id);
        },
      },
    } as any;

    const { state, commentId } = await loadOrCreateState(octokit, 'o', 'r', 1);
    expect(state.cycle).toBe(3);
    expect(state.revision).toBe(12);
    expect(commentId).toBe(2);
    expect(deleted).toEqual([3]);
  });

  test('unparseable marker comment falls back to default only after a retry', async () => {
    let listCalls = 0;
    const octokit = {
      issues: {
        listComments: async () => {
          listCalls++;
          return {
            data: [{ id: 5, body: '<!-- pr-agent-orchestrator -->\n```json\n{corrupted' }],
          };
        },
      },
    } as any;

    const { state, commentId } = await loadOrCreateState(octokit, 'o', 'r', 1);
    expect(listCalls).toBe(2);
    expect(state.cycle).toBe(0);
    expect(commentId).toBeUndefined();
  }, 15_000);
});

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

describe('two writes in one run (agent-resume path, #3851)', () => {
  /** Mock whose stored body is the single source of truth across writes. */
  function revisionTrackingOctokit(initial: string) {
    const store = { body: initial };
    return {
      store,
      octokit: {
        issues: {
          getComment: async () => ({ data: { id: 99, body: store.body } }),
          updateComment: async (args: { body: string }) => {
            store.body = args.body;
            return { data: { id: 99, body: args.body } };
          },
          createComment: async () => {
            throw new Error('should not create');
          },
        },
      } as any,
    };
  }

  test('reusing the stale local revision loses the second write', async () => {
    const local = makeState({ cycle: 1, revision: 4, selfDispatches: 3 });
    const { store, octokit } = revisionTrackingOctokit(formatStateComment(local));

    // First write (e.g. the agent-resume reset) lands.
    const first = await saveState(octokit, 'o', 'r', 1, { ...local, cycle: 2 }, 99);
    expect(first.wrote).toBe(true);

    // Second write in the same run still carrying revision 4 is refused, so
    // the selfDispatches reset it was carrying is silently dropped.
    const second = await saveState(
      octokit,
      'o',
      'r',
      1,
      { ...local, cycle: 2, selfDispatches: 0 },
      99,
    );
    expect(second.wrote).toBe(false);
    expect(parseStateFromComment(store.body)?.selfDispatches).toBe(3);
  });

  test('adopting the returned revision lets the second write land', async () => {
    const local = makeState({ cycle: 1, revision: 4, selfDispatches: 3 });
    const { store, octokit } = revisionTrackingOctokit(formatStateComment(local));

    const first = await saveState(octokit, 'o', 'r', 1, { ...local, cycle: 2 }, 99);
    expect(first.wrote).toBe(true);

    // This is what plan.ts's `persist` helper does.
    const carried = { ...local, cycle: 2, revision: first.revision };
    const second = await saveState(
      octokit,
      'o',
      'r',
      1,
      { ...carried, selfDispatches: 0 },
      99,
    );
    expect(second.wrote).toBe(true);
    expect(parseStateFromComment(store.body)?.selfDispatches).toBe(0);
    expect(parseStateFromComment(store.body)?.cycle).toBe(2);
  });
});
