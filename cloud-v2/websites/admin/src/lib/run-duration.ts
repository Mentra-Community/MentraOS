export function runDuration(startedAt: unknown, finishedAt: unknown): string | null {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return null;
  return elapsedDuration(Date.parse(finishedAt) - Date.parse(startedAt));
}

export function elapsedDuration(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms === 0) return "0s";
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
