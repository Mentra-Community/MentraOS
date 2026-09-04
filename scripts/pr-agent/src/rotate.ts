import type { ReviewSlot } from './types.js';

const ROTATION_PAIRS_3: ReviewSlot[][] = [
  ['bugbot', 'standards'],
  ['bugbot', 'depth'],
  ['standards', 'depth'],
];

// Codex-enabled rotation (4 choose 2), ordered so consecutive cycles swap both
// slots and the codex slot appears every other cycle for vendor diversity.
const ROTATION_PAIRS_4: ReviewSlot[][] = [
  ['bugbot', 'standards'],
  ['codex', 'depth'],
  ['bugbot', 'codex'],
  ['standards', 'depth'],
  ['bugbot', 'depth'],
  ['codex', 'standards'],
];

/** The codex slot only runs when the OPENAI_API_KEY secret is configured. */
export function codexSlotAvailable(): boolean {
  return process.env.HAS_OPENAI_API_KEY === 'true';
}

const PROSE_FILE = /\.(md|mdx|txt|rst)$/i;
/** Docs trees whose non-code contents (diagrams, fixtures) are also prose. */
const DOCS_DIR = /^(notes|mintlify-docs)\//;
/** Extensions that are code wherever they live, including inside docs trees. */
const CODE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|kts|swift|py|rb|go|rs|c|h|cc|cpp|m|mm|sh|ya?ml|json|gradle|podspec)$/i;

function isProseFile(file: string): boolean {
  if (CODE_FILE.test(file)) return false;
  return PROSE_FILE.test(file) || DOCS_DIR.test(file);
}

/**
 * Bugbot silently declines diffs with no code in them — it opens no check run
 * at all — so scheduling it on a prose-only PR spends a slot and a poll window
 * for nothing. Callers substitute a model slot instead (see
 * `substituteBugbotSlot`).
 */
export function isBugbotReviewable(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return false;
  return !changedFiles.every(isProseFile);
}

/** Preference order for the model slot that stands in for bugbot. */
const SUBSTITUTE_PREFERENCE: ReviewSlot[] = ['depth', 'standards', 'codex'];

/**
 * Swap the bugbot slot for a model slot the pair is not already using, so a
 * diff Bugbot will not review still gets two independent opinions.
 */
export function substituteBugbotSlot(
  pair: ReviewSlot[],
  codexAvailable = codexSlotAvailable(),
): ReviewSlot[] {
  if (!pair.includes('bugbot')) return pair;
  const rest: ReviewSlot[] = pair.filter((slot) => slot !== 'bugbot');
  const replacement = SUBSTITUTE_PREFERENCE.find(
    (slot) => !rest.includes(slot) && (slot !== 'codex' || codexAvailable),
  );
  return replacement ? [...rest, replacement] : rest;
}

function rotationPairs(codexAvailable: boolean): ReviewSlot[][] {
  return codexAvailable ? ROTATION_PAIRS_4 : ROTATION_PAIRS_3;
}

export function pairForCycle(cycle: number, codexAvailable = codexSlotAvailable()): ReviewSlot[] {
  const pairs = rotationPairs(codexAvailable);
  const n = pairs.length;
  return pairs[((cycle % n) + n) % n]!;
}

export function frozenPairFromFindings(
  counts: Record<ReviewSlot, number>,
  codexAvailable = codexSlotAvailable(),
): ReviewSlot[] {
  const available = new Set(rotationPairs(codexAvailable).flat());
  const entries = (Object.entries(counts) as [ReviewSlot, number][]).filter(
    ([slot, n]) => n > 0 && available.has(slot),
  );
  entries.sort((a, b) => b[1] - a[1]);
  if (entries.length >= 2) {
    return [entries[0]![0], entries[1]![0]];
  }
  if (entries.length === 1) {
    const other = [...available].find((s) => s !== entries[0]![0]);
    return other ? [entries[0]![0], other] : pairForCycle(0, codexAvailable);
  }
  return pairForCycle(0, codexAvailable);
}

export function resolveActivePair(
  state: {
    cycle: number;
    fixRound: number;
    phase: 'discovery' | 'convergence';
    frozenPair?: ReviewSlot[];
    openFindings: { source: string }[];
  },
  forceRotation: boolean,
  codexAvailable = codexSlotAvailable(),
): ReviewSlot[] {
  if (forceRotation) {
    return pairForCycle(state.cycle, codexAvailable);
  }
  const inConvergence =
    state.phase === 'convergence' ||
    state.fixRound > 0 ||
    state.openFindings.length > 0;

  if (inConvergence && state.frozenPair?.length === 2) {
    // A frozen pair minted while codex was available must not schedule the
    // codex slot after the OPENAI_API_KEY secret is removed.
    if (codexAvailable || !state.frozenPair.includes('codex')) {
      return state.frozenPair;
    }
  }
  return pairForCycle(state.cycle, codexAvailable);
}
