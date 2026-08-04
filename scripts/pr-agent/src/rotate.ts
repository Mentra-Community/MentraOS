import type { ReviewSlot } from './types.js';

const ROTATION_PAIRS: ReviewSlot[][] = [
  ['bugbot', 'standards'],
  ['bugbot', 'depth'],
  ['standards', 'depth'],
];

export function pairForCycle(cycle: number): ReviewSlot[] {
  return ROTATION_PAIRS[((cycle % 3) + 3) % 3]!;
}

export function frozenPairFromFindings(
  counts: Record<ReviewSlot, number>,
): ReviewSlot[] {
  const entries = (Object.entries(counts) as [ReviewSlot, number][]).filter(
    ([, n]) => n > 0,
  );
  entries.sort((a, b) => b[1] - a[1]);
  if (entries.length >= 2) {
    return [entries[0]![0], entries[1]![0]];
  }
  if (entries.length === 1) {
    const other = ROTATION_PAIRS.flat().find((s) => s !== entries[0]![0]);
    return other ? [entries[0]![0], other] : pairForCycle(0);
  }
  return pairForCycle(0);
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
): ReviewSlot[] {
  if (forceRotation) {
    return pairForCycle(state.cycle);
  }
  const inConvergence =
    state.phase === 'convergence' ||
    state.fixRound > 0 ||
    state.openFindings.length > 0;

  if (inConvergence && state.frozenPair?.length === 2) {
    return state.frozenPair;
  }
  return pairForCycle(state.cycle);
}
