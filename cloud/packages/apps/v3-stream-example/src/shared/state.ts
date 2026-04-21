// ─── Shared state types — imported by both backend and frontend ───────────────

/** Stream state — mirrors StreamManager.getSnapshot() */
export interface StreamState {
  active: boolean;
  mode: "direct" | "managed" | null;
  url: string | null;
  startedAt: string | null;
  status: string;
  error: string | null;
  hlsUrl: string | null;
  dashUrl: string | null;
  webrtcUrl: string | null;
  previewUrl: string | null;
  streamId: string | null;
}

/** Top-level app state synced backend → frontend via SSE */
export interface AppState {
  stream: StreamState;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_STREAM: StreamState = {
  active: false,
  mode: null,
  url: null,
  startedAt: null,
  status: "idle",
  error: null,
  hlsUrl: null,
  dashUrl: null,
  webrtcUrl: null,
  previewUrl: null,
  streamId: null,
};

export const DEFAULT_APP_STATE: AppState = {
  stream: { ...DEFAULT_STREAM },
};
