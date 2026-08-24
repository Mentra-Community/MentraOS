/**
 * Unit tests for the orchestrator overhaul: external ingestion, stable
 * fingerprints, empty-cycle guard, codex rotation, PAT CI gate, inline
 * comments, and review-comment rendering. Run with `bun test`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { aggregateCycle } from '../src/aggregate.js';
import { isCiGreen, type CiCheckStatus } from '../src/ci-gates.js';
import { resetConfigCache } from '../src/config.js';
import { fetchExternalFindings } from '../src/external-reviews.js';
import {
  fingerprintFinding,
  sourceCounts,
  verdictToFindings,
} from '../src/findings.js';
import { postInlineFindings } from '../src/inline-comments.js';
import { buildReviewComment } from '../src/review-comment.js';
import { frozenPairFromFindings, pairForCycle, resolveActivePair } from '../src/rotate.js';
import { PrAgentStateSchema, type Finding } from '../src/types.js';

const REPO_ROOT = process.env.GITHUB_WORKSPACE ?? '/workspace';

function finding(partial: Partial<Finding>): Finding {
  return {
    id: 'aaaaaa',
    fingerprint: 'file.ts:L10',
    source: 'standards',
    severity: 'blocking',
    file: 'file.ts',
    line: 10,
    message: 'msg',
    status: 'open',
    introducedCycle: 0,
    lastSeenCycle: 0,
    ...partial,
  };
}

beforeEach(() => {
  resetConfigCache();
  delete process.env.HAS_OPENAI_API_KEY;
  delete process.env.PR_AGENT_HAS_PAT;
  process.env.CI_TRIGGER_FAILED = 'false';
});

describe('fingerprintFinding', () => {
  test('same line bucket, different wording => same fingerprint', () => {
    const a = fingerprintFinding('Foo.java', 'issue below minimum', 101);
    const b = fingerprintFinding('Foo.java', 'totally reworded description', 104);
    expect(a).toBe(b);
    expect(a).toBe('foo.java:L100');
  });

  test('distant lines differ', () => {
    expect(fingerprintFinding('Foo.java', 'x', 101)).not.toBe(
      fingerprintFinding('Foo.java', 'x', 401),
    );
  });

  test('no line falls back to normalized message hash', () => {
    const a = fingerprintFinding('Foo.java', 'Value 42 is `bad`');
    const b = fingerprintFinding('Foo.java', 'value 99 is bad');
    expect(a).toBe(b); // numbers masked, quotes stripped, case-folded
    expect(a).not.toContain(':L');
  });
});

describe('verdictToFindings ref echo', () => {
  test('ref inherits the existing fingerprint case-insensitively', () => {
    const existing = finding({ id: 'AbC123', fingerprint: 'foo.java:L100' });
    const { blocking } = verdictToFindings(
      {
        verdict: 'changes_requested',
        findings: [
          { severity: 'blocking', file: 'Other.java', line: 999, message: 'reworded', ref: 'abc123' },
        ],
      },
      'depth',
      3,
      [existing],
    );
    expect(blocking[0]!.fingerprint).toBe('foo.java:L100');
  });

  test('unknown ref mints a fresh identity', () => {
    const { blocking } = verdictToFindings(
      {
        verdict: 'changes_requested',
        findings: [
          { severity: 'blocking', file: 'A.java', line: 55, message: 'new', ref: 'zzzzzz' },
        ],
      },
      'depth',
      3,
      [finding({})],
    );
    expect(blocking[0]!.fingerprint).toBe('a.java:L60');
  });
});

describe('rotation', () => {
  test('3-slot roster never schedules codex', () => {
    for (let i = 0; i < 6; i++) {
      expect(pairForCycle(i, false)).not.toContain('codex');
    }
  });

  test('4-slot roster schedules codex regularly and covers all slots', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) for (const s of pairForCycle(i, true)) seen.add(s);
    expect([...seen].sort()).toEqual(['bugbot', 'codex', 'depth', 'standards']);
  });

  test('frozen pair containing codex is remapped when codex unavailable', () => {
    const pair = resolveActivePair(
      {
        cycle: 3,
        fixRound: 1,
        phase: 'convergence',
        frozenPair: ['codex', 'depth'],
        openFindings: [{ source: 'codex' }],
      },
      false,
      false,
    );
    expect(pair).not.toContain('codex');
    expect(pair.length).toBe(2);
  });

  test('frozen pair kept verbatim when codex available', () => {
    const pair = resolveActivePair(
      {
        cycle: 3,
        fixRound: 1,
        phase: 'convergence',
        frozenPair: ['codex', 'depth'],
        openFindings: [{ source: 'codex' }],
      },
      false,
      true,
    );
    expect(pair).toEqual(['codex', 'depth']);
  });

  test('sourceCounts has a codex bucket and frozenPairFromFindings uses counts', () => {
    const counts = sourceCounts([
      finding({ source: 'codex', fingerprint: 'a:L10' }),
      finding({ source: 'codex', fingerprint: 'b:L10' }),
      finding({ source: 'depth', fingerprint: 'c:L10' }),
    ]);
    expect(counts.codex).toBe(2);
    expect(frozenPairFromFindings(counts, true)).toEqual(['codex', 'depth']);
  });
});

describe('aggregateCycle', () => {
  const cleanApprove =
    'clean\n{"verdict":"approve","findings":[]}';
  const oneBlocking =
    'found\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"Bar.java","line":42,"message":"bad"}]}';

  test('empty cycle freezes all counters and schedules nothing', () => {
    const st = PrAgentStateSchema.parse({
      cycle: 3,
      stagnationFixRounds: 1,
      consecutiveNoNewReviews: 1,
      lastOpenCount: 2,
    });
    const out = aggregateCycle(REPO_ROOT, st, {}, [], ['standards', 'bugbot']);
    expect(out.emptyCycle).toBe(true);
    expect(out.state.cycle).toBe(3);
    expect(out.state.stagnationFixRounds).toBe(1);
    expect(out.state.consecutiveNoNewReviews).toBe(1);
    expect(out.shouldFix).toBe(false);
    expect(out.shouldHandoff).toBe(false);
  });

  test('bugbot incomplete alone (single-slot pair) is an empty cycle', () => {
    const st = PrAgentStateSchema.parse({ cycle: 2 });
    const out = aggregateCycle(
      REPO_ROOT,
      st,
      { bugbotCheckCompleted: false },
      [],
      ['bugbot'],
    );
    expect(out.emptyCycle).toBe(true);
    expect(out.state.cycle).toBe(2);
  });

  test('codex slot text is ingested like standards/depth', () => {
    const st = PrAgentStateSchema.parse({ cycle: 0 });
    const out = aggregateCycle(
      REPO_ROOT,
      st,
      { codex: oneBlocking, standards: cleanApprove },
      [],
      ['codex', 'standards'],
    );
    expect(out.emptyCycle).toBeUndefined();
    expect(out.state.openFindings.some((f) => f.source === 'codex')).toBe(true);
    expect(out.shouldFix).toBe(true);
  });

  test('external blocking finding drives shouldFix but not new-blocking or divergence counters', () => {
    const ext = finding({
      source: 'external:cursor[bot]',
      fingerprint: 'external:cursor[bot]:1',
      severity: 'blocking',
    });
    const st = PrAgentStateSchema.parse({ cycle: 0 });
    const out = aggregateCycle(
      REPO_ROOT,
      st,
      {
        standards: cleanApprove,
        external: { current: [ext], sources: ['external:cursor[bot]'] },
      },
      [],
      ['standards'],
    );
    expect(out.shouldFix).toBe(true);
    expect(out.newBlockingCount).toBe(0);
    // consecutive still increments: model reviews were clean
    expect(out.state.consecutiveNoNewReviews).toBe(1);
    // external excluded from stagnation baseline
    expect(out.state.lastOpenCount).toBe(0);
    // external excluded from inline-comment candidates
    expect(out.newBlockingFindings.length).toBe(0);
  });

  test('external finding whose comment disappeared is resolved', () => {
    const ext = finding({
      source: 'external:cursor[bot]',
      fingerprint: 'external:cursor[bot]:1',
    });
    const st = PrAgentStateSchema.parse({ cycle: 1, openFindings: [ext] });
    const out = aggregateCycle(
      REPO_ROOT,
      st,
      {
        standards: cleanApprove,
        external: { current: [], sources: ['external:cursor[bot]'] },
      },
      [],
      ['standards'],
    );
    expect(out.state.openFindings.length).toBe(0);
    expect(
      out.state.resolvedFindings.some((f) => f.fingerprint === 'external:cursor[bot]:1'),
    ).toBe(true);
  });

  test('muted external fingerprints are not re-ingested', () => {
    const ext = finding({
      source: 'external:cursor[bot]',
      fingerprint: 'external:cursor[bot]:1',
    });
    const st = PrAgentStateSchema.parse({
      cycle: 1,
      mutedFingerprints: ['external:cursor[bot]:1'],
    });
    const out = aggregateCycle(
      REPO_ROOT,
      st,
      {
        standards: cleanApprove,
        external: { current: [ext], sources: ['external:cursor[bot]'] },
      },
      [],
      ['standards'],
    );
    expect(out.state.openFindings.length).toBe(0);
    expect(out.shouldFix).toBe(false);
  });

  test('stagnation counts only internal findings', () => {
    const internal = finding({ fingerprint: 'a.ts:L10' });
    const ext = finding({
      source: 'external:cursor[bot]',
      fingerprint: 'external:cursor[bot]:9',
    });
    // lastOpenCount=1 (internal), and this cycle internal count is still 1 =>
    // stagnation increments regardless of the external finding coming and going.
    const st = PrAgentStateSchema.parse({
      cycle: 2,
      lastOpenCount: 1,
      openFindings: [internal],
    });
    const out = aggregateCycle(
      REPO_ROOT,
      st,
      {
        standards:
          'still there\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.ts","line":10,"message":"still bad"}]}',
        external: { current: [ext], sources: ['external:cursor[bot]'] },
      },
      [],
      ['standards'],
    );
    expect(out.state.stagnationFixRounds).toBe(1);
    expect(out.state.lastOpenCount).toBe(1);
  });
});

describe('isCiGreen PAT gate', () => {
  const awaiting: CiCheckStatus[] = [
    { name: 'Build', status: 'pending', conclusion: null, required: true, awaitingApproval: true },
  ];

  test('without PAT, awaiting-approval checks are conceded as green', () => {
    process.env.PR_AGENT_HAS_PAT = 'false';
    expect(isCiGreen(awaiting)).toBe(true);
  });

  test('with PAT, awaiting-approval checks block the gate', () => {
    process.env.PR_AGENT_HAS_PAT = 'true';
    expect(isCiGreen(awaiting)).toBe(false);
  });

  test('with PAT, genuinely green checks still pass', () => {
    process.env.PR_AGENT_HAS_PAT = 'true';
    expect(
      isCiGreen([{ name: 'Build', status: 'completed', conclusion: 'success', required: true }]),
    ).toBe(true);
  });
});

describe('fetchExternalFindings', () => {
  type Comment = {
    id: number;
    user?: { login: string };
    path: string;
    line: number | null;
    original_line?: number | null;
    position?: number | null;
    body?: string;
    in_reply_to_id?: number;
  };

  function octokitWith(comments: Comment[]) {
    return {
      pulls: {
        listReviewComments: async ({ page }: { page: number }) => ({
          data: page === 1 ? comments : [],
        }),
      },
    } as never;
  }

  test('classifies severity, skips replies/outdated/non-allowlisted, strips HTML', async () => {
    const comments: Comment[] = [
      {
        id: 1,
        user: { login: 'cursor[bot]' },
        path: 'a.ts',
        line: 12,
        position: 3,
        body: '### Bug\n\n**High Severity**\n\n<!-- meta -->details here',
      },
      { id: 2, user: { login: 'cursor[bot]' }, path: 'b.ts', line: 5, position: 1, body: 'minor style note' },
      { id: 3, user: { login: 'cursor[bot]' }, path: 'c.ts', line: null, position: null, body: '**High Severity** outdated' },
      { id: 4, user: { login: 'cursor[bot]' }, path: 'a.ts', line: 12, position: 3, body: 'reply', in_reply_to_id: 1 },
      { id: 5, user: { login: 'random-user' }, path: 'd.ts', line: 9, position: 2, body: '**High Severity** not allowlisted' },
    ];
    const res = await fetchExternalFindings(
      octokitWith(comments),
      'o',
      'r',
      1,
      REPO_ROOT,
      7,
    );
    expect(res.current.length).toBe(2);
    const blocking = res.current.find((f) => f.fingerprint.endsWith(':1'))!;
    expect(blocking.severity).toBe('blocking');
    expect(blocking.message).not.toContain('<!--');
    expect(blocking.file).toBe('a.ts');
    expect(blocking.line).toBe(12);
    const nit = res.current.find((f) => f.fingerprint.endsWith(':2'))!;
    expect(nit.severity).toBe('nit');
    expect(res.sources).toEqual(['external:cursor[bot]']);
  });
});

describe('postInlineFindings', () => {
  function mockOctokit(opts: { existingBodies?: string[]; failBatch?: boolean; failPaths?: string[] }) {
    const calls = { reviews: [] as unknown[], comments: [] as Array<{ path: string }> };
    const octokit = {
      pulls: {
        listReviewComments: async ({ page }: { page: number }) => ({
          data: page === 1 ? (opts.existingBodies ?? []).map((b, i) => ({ id: i, body: b })) : [],
        }),
        createReview: async (args: unknown) => {
          if (opts.failBatch) throw new Error('422 line outside diff');
          calls.reviews.push(args);
          return {};
        },
        createReviewComment: async (args: { path: string }) => {
          if ((opts.failPaths ?? []).includes(args.path)) throw new Error('422');
          calls.comments.push(args);
          return {};
        },
      },
    } as never;
    return { octokit, calls };
  }

  test('posts one batch review for fresh blocking findings with lines', async () => {
    const { octokit, calls } = mockOctokit({});
    await postInlineFindings(octokit, 'o', 'r', 1, 'sha', [
      finding({ id: 'f1', line: 10 }),
      finding({ id: 'f2', line: 0 }), // no usable line: skipped
      finding({ id: 'f3', line: 20, severity: 'nit' }), // nit: skipped
    ]);
    expect(calls.reviews.length).toBe(1);
    const review = calls.reviews[0] as { comments: Array<{ body: string }> };
    expect(review.comments.length).toBe(1);
    expect(review.comments[0]!.body).toContain('pr-agent-finding:f1');
    expect(review.comments[0]!.body).toContain('agent-resolve f1');
  });

  test('marker dedupe suppresses already-posted findings', async () => {
    const { octokit, calls } = mockOctokit({
      existingBodies: ['<!-- pr-agent-finding:f1 --> already here'],
    });
    await postInlineFindings(octokit, 'o', 'r', 1, 'sha', [finding({ id: 'f1', line: 10 })]);
    expect(calls.reviews.length).toBe(0);
    expect(calls.comments.length).toBe(0);
  });

  test('batch rejection falls back to per-comment posting and skips bad anchors', async () => {
    const { octokit, calls } = mockOctokit({ failBatch: true, failPaths: ['bad.ts'] });
    await postInlineFindings(octokit, 'o', 'r', 1, 'sha', [
      finding({ id: 'f1', file: 'good.ts', fingerprint: 'good.ts:L10', line: 10 }),
      finding({ id: 'f2', file: 'bad.ts', fingerprint: 'bad.ts:L20', line: 20 }),
    ]);
    expect(calls.comments.map((c) => c.path)).toEqual(['good.ts']);
  });
});

describe('buildReviewComment', () => {
  test('no ingested reviews renders the counters-unchanged banner without counts', () => {
    const st = PrAgentStateSchema.parse({
      cycle: 4,
      openFindings: [finding({})],
      nitFindings: [finding({ severity: 'nit' })],
    });
    const body = buildReviewComment(st, {}, ['standards', 'bugbot']);
    expect(body).toContain('No model reviews were ingested');
    expect(body).toContain('counters unchanged');
    expect(body).not.toContain('blocking ·');
  });

  test('codex section renders with its own label', () => {
    const st = PrAgentStateSchema.parse({ cycle: 1 });
    const body = buildReviewComment(
      st,
      { codex: 'all good\n{"verdict":"approve","findings":[]}' },
      ['codex'],
    );
    expect(body).toContain('Codex — review');
    expect(body).toContain('✅ approve');
  });
});
