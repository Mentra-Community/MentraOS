/** A single memory-usage entry attributed to a named owner within a given scope. */
export interface MemoryOwnerStat {
  owner: string;
  scope: "session" | "app-session" | "stream" | "global";
  itemCount: number;
  estimatedBytes: number;
  metadata?: Record<string, string | number | boolean | null>;
}

/** Aggregate memory census for one session, combining all owner-level stats. */
export interface SessionMemoryCensus {
  estimatedBytes: number;
  owners: MemoryOwnerStat[];
}

/** Implemented by any component that can report its current memory footprint. */
export interface MemoryStatsProvider {
  getMemoryStats(): MemoryOwnerStat[];
}
