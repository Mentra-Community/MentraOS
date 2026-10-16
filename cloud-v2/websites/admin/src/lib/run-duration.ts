export function runDuration(startedAt: unknown, finishedAt: unknown): string | null {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return null;
  return elapsedDuration(Date.parse(finishedAt) - Date.parse(startedAt));
}

export function elapsedDuration(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${remainingSeconds}s`;
}
