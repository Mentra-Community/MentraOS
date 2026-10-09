export const NIGHTLY_COMPLETION_BOUNDARY_REASON = "Nightly occurrence reached its completion boundary.";

/** Explain recorded expiry and absent assignment without reconstructing historical host state. */
export function nightlyUnassignedReason(input: {reason?: string; startedAt: string; observedAt?: string;
  unassigned: boolean; recordedWaitingReason?: string}): string | undefined {
  if (!input.unassigned || input.reason !== NIGHTLY_COMPLETION_BOUNDARY_REASON || !input.observedAt
    || !Number.isFinite(Date.parse(input.startedAt)) || !Number.isFinite(Date.parse(input.observedAt))
    || Date.parse(input.observedAt) < Date.parse(input.startedAt) + 3 * 3600_000) return input.reason;
  const reason = "Nightly deadline expired before a compatible lane and required resources were assigned.";
  const recorded = input.recordedWaitingReason?.trim();
  return recorded ? `${reason} Last recorded waiting reason: ${recorded}`.slice(0, 2000) : reason;
}
