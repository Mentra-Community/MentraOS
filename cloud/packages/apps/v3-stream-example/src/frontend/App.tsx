import { useState } from "react";
import { useMentraAuth } from "@mentra/react";
import { WebRTCPlayer } from "./WebRTCPlayer";
import { useAppState } from "./use-app-state";

function authHeaders(token?: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function postStreamStart(
  mode: "managed" | "direct" = "managed",
  token?: string | null,
): Promise<{
  ok: boolean;
  error?: string;
  webrtcUrl?: string;
  hlsUrl?: string;
}> {
  const res = await fetch(`/api/stream/start/${mode}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(token),
  });
  return res.json();
}

async function postStreamStop(
  token?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/stream/stop", {
    method: "POST",
    credentials: "include",
    headers: authHeaders(token),
  });
  return res.json();
}

export default function App() {
  const { userId, isLoading, error, isAuthenticated, frontendToken } =
    useMentraAuth();
  const { state, isConnected } = useAppState(isAuthenticated, frontendToken);
  const streamInfo = state.stream;
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleStart = async () => {
    setActionPending(true);
    setActionError(null);
    try {
      const result = await postStreamStart("managed", frontendToken);
      if (!result.ok) setActionError(result.error || "Failed to start stream");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(false);
    }
  };

  const handleStop = async () => {
    setActionPending(true);
    setActionError(null);
    try {
      const result = await postStreamStop(frontendToken);
      if (!result.ok) setActionError(result.error || "Failed to stop stream");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(false);
    }
  };

  const isStreaming = streamInfo.active;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center">
        <p className="text-neutral-500 text-sm">Authenticating…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center gap-2">
        <p className="text-red-400 text-sm">{error}</p>
        <p className="text-neutral-500 text-xs">
          Open this page from the Mentra app.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-3xl px-4 py-6 flex flex-col gap-5">
        {/* Header */}
        <header>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-emerald-400 mb-1">
            Stream Test
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            Camera Streaming
          </h1>
          <p className="text-sm text-neutral-500 mt-1">
            Stream video from your Mentra Live glasses.
          </p>
        </header>

        {/* Video Player — only when streaming */}
        {isStreaming &&
          streamInfo.mode === "managed" &&
          (streamInfo.webrtcUrl || streamInfo.hlsUrl) && (
            <section>
              {streamInfo.webrtcUrl ? (
                <div className="w-full aspect-video rounded-lg overflow-hidden bg-black">
                  <WebRTCPlayer
                    url={streamInfo.webrtcUrl}
                    muted={false}
                    showFullscreenButton={true}
                  />
                </div>
              ) : streamInfo.hlsUrl ? (
                <video
                  controls
                  autoPlay
                  muted
                  playsInline
                  className="w-full rounded-lg bg-black"
                  src={streamInfo.hlsUrl}
                />
              ) : null}

              <div className="flex gap-3 mt-2 text-xs">
                {streamInfo.hlsUrl && (
                  <a
                    href={streamInfo.hlsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    HLS ↗
                  </a>
                )}
                {streamInfo.dashUrl && (
                  <a
                    href={streamInfo.dashUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    DASH ↗
                  </a>
                )}
              </div>
            </section>
          )}

        {/* Controls */}
        <div className="flex gap-3">
          <button
            onClick={handleStart}
            disabled={actionPending || isStreaming}
            type="button"
            className="flex-1 rounded-md bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-neutral-950 hover:bg-emerald-400 active:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {actionPending && !isStreaming ? "Starting…" : "Start Stream"}
          </button>
          <button
            onClick={handleStop}
            disabled={actionPending || !isStreaming}
            type="button"
            className="flex-1 rounded-md bg-neutral-800 px-4 py-2.5 text-sm font-semibold text-neutral-100 hover:bg-neutral-700 active:bg-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {actionPending && isStreaming ? "Stopping…" : "Stop Stream"}
          </button>
        </div>

        {actionError && (
          <p className="text-red-400 text-sm -mt-2">{actionError}</p>
        )}

        {/* Status row */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm border-t border-neutral-800 pt-4">
          <span
            className={isStreaming ? "text-emerald-400" : "text-neutral-500"}
          >
            {isStreaming ? "● Streaming" : "○ Idle"}
          </span>

          {streamInfo.mode && (
            <span className="text-neutral-400 font-mono text-xs">
              {streamInfo.mode}
            </span>
          )}

          {streamInfo.startedAt && (
            <span className="text-neutral-500 text-xs">
              Started {new Date(streamInfo.startedAt).toLocaleTimeString()}
            </span>
          )}

          {streamInfo.streamId && (
            <span className="text-neutral-600 font-mono text-xs">
              {streamInfo.streamId}
            </span>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-600 border-t border-neutral-800/50 pt-3">
          <span>{userId}</span>
          <span
            className={isConnected ? "text-emerald-600" : "text-neutral-700"}
          >
            {isConnected ? "● connected" : "○ disconnected"}
          </span>
        </div>
      </div>
    </div>
  );
}
