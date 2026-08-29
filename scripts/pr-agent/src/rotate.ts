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
