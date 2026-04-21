export type StateSource = "session" | "webview";

export type TranscriptMode = "live" | "final";

export interface AppState {
  lastTranscript: string | null;
  transcriptCount: number;
  transcriptMode: TranscriptMode | null;
  webviewNote: string;
  lastUpdatedAt: string | null;
}

export const APP_STATE_KEYS = [
  "lastTranscript",
  "transcriptCount",
  "transcriptMode",
  "webviewNote",
  "lastUpdatedAt",
] as const;

export type AppStateKey = (typeof APP_STATE_KEYS)[number];

export function isAppStateKey(key: string): key is AppStateKey {
  return (APP_STATE_KEYS as readonly string[]).includes(key);
}

export interface RuntimeState {
  sessionId: string | null;
  status: "connected" | "stopped" | "no-session";
  reconnectCount: number;
  lastReconnectAt: string | null;
  stopReason: string | null;
}

export interface StateSnapshot {
  runtime: RuntimeState;
  state: Partial<AppState>;
}

export interface StateUpdate<K extends AppStateKey = AppStateKey> {
  key: K;
  source: StateSource;
  timestamp: string;
  value: AppState[K];
}
