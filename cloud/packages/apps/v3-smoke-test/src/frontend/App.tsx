import { useEffect, useState } from "react";
import { useMentraAuth, isInMentraOS, getMentraOSPlatform } from "@mentra/react";

import type { AppState } from "../shared/state";
import {
  useMentraActions,
  useMentraConnection,
  useMentraRuntime,
  useMentraState,
  useMentraStateError,
} from "./mentra-state";

interface ProbeResult {
  userId: string | null;
  hasCookie: boolean;
  hasRuntimeSession: boolean;
  runtimeSessionId: string | null;
  runtimeStatus: string;
}

async function fetchProbe(path: string, frontendToken?: string | null): Promise<ProbeResult> {
  const response = await fetch(path, {
    credentials: "include",
    headers: frontendToken ? { Authorization: `Bearer ${frontendToken}` } : undefined,
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as ProbeResult;
}

export default function App() {
  const { userId, frontendToken, isLoading, error, isAuthenticated } = useMentraAuth();
  const { setMentraState } = useMentraActions();
  const connection = useMentraConnection();
  const runtime = useMentraRuntime();
  const stateError = useMentraStateError();
  const lastTranscript = useMentraState("lastTranscript");
  const transcriptCount = useMentraState("transcriptCount");
  const transcriptMode = useMentraState("transcriptMode");
  const webviewNote = useMentraState("webviewNote");
  const lastUpdatedAt = useMentraState("lastUpdatedAt");
  const [cookieProbe, setCookieProbe] = useState<ProbeResult | null>(null);
  const [tokenProbe, setTokenProbe] = useState<ProbeResult | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [probeError, setProbeError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const [cookieResult, tokenResult] = await Promise.all([
          fetchProbe("/api/me"),
          fetchProbe("/api/me-via-token", frontendToken),
        ]);

        if (!cancelled) {
          setCookieProbe(cookieResult);
          setTokenProbe(tokenResult);
          setProbeError(null);
        }
      } catch (probeLoadError) {
        if (!cancelled) {
          setProbeError((probeLoadError as Error).message);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [frontendToken, isAuthenticated, refreshCount]);

  useEffect(() => {
    setNoteDraft(webviewNote ?? "");
  }, [webviewNote]);

  if (isLoading) {
    return (
      <main className="shell">
        <section className="panel hero">
          <p className="eyebrow">SDK v3 Webview</p>
          <h1>Initializing webview auth</h1>
          <p className="muted">Waiting for the React SDK to resolve the Mentra session.</p>
        </section>
      </main>
    );
  }

  if (error) {
    return (
      <main className="shell">
        <section className="panel hero">
          <p className="eyebrow">SDK v3 Webview</p>
          <h1>Authentication failed</h1>
          <p className="error">{error}</p>
          <p className="muted">Open this page from Mentra so the signed user token or temp token is present.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <div className="hero-header">
          <div>
            <p className="eyebrow">SDK v3 Webview</p>
            <h1>Auth, state, and HMR smoke test</h1>
          </div>
          <button className="refresh" onClick={() => setRefreshCount((count) => count + 1)} type="button">
            Refresh probes
          </button>
        </div>
        <p className="muted">
          This page validates the `@mentra/react` auth bootstrap, cookie-backed backend auth, frontend-token auth,
          authenticated shared state streaming, and Bun HMR under the same v3 mini app.
        </p>
      </section>

      <section className="grid">
        <article className="panel">
          <p className="eyebrow">Shared state</p>
          <dl className="facts">
            <div>
              <dt>State connection</dt>
              <dd>{connection}</dd>
            </div>
            <div>
              <dt>Runtime session</dt>
              <dd>{runtime.sessionId ? `${runtime.status} (${runtime.sessionId})` : runtime.status}</dd>
            </div>
            <div>
              <dt>Reconnect count</dt>
              <dd>{runtime.reconnectCount}</dd>
            </div>
            <div>
              <dt>Last update</dt>
              <dd>{lastUpdatedAt ?? "waiting"}</dd>
            </div>
          </dl>
          {stateError ? <p className="error">{stateError}</p> : null}
        </article>

        <article className="panel transcript-panel">
          <p className="eyebrow">Transcript mirror</p>
          <p className="transcript">{lastTranscript ?? "Waiting for transcription..."}</p>
          <dl className="facts compact">
            <div>
              <dt>Mode</dt>
              <dd>{transcriptMode ?? "none"}</dd>
            </div>
            <div>
              <dt>Events seen</dt>
              <dd>{transcriptCount ?? 0}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="grid">
        <article className="panel">
          <p className="eyebrow">Webview write path</p>
          <p className="muted">
            This uses the authenticated webview session cookie to post a state change back to the backend.
          </p>
          <label className="field">
            <span>Webview note</span>
            <textarea
              onChange={(event) => setNoteDraft(event.currentTarget.value)}
              placeholder="Type a note to push into shared state"
              rows={4}
              value={noteDraft}
            />
          </label>
          <button
            className="refresh"
            onClick={async () => {
              await setMentraState("webviewNote", noteDraft as AppState["webviewNote"]);
            }}
            type="button">
            Save note to shared state
          </button>
          <p className="saved-note">{webviewNote ? `Saved: ${webviewNote}` : "No saved note yet"}</p>
        </article>

        <article className="panel">
          <p className="eyebrow">Frontend auth</p>
          <dl className="facts">
            <div>
              <dt>User ID</dt>
              <dd>{userId ?? "none"}</dd>
            </div>
            <div>
              <dt>Authenticated</dt>
              <dd>{isAuthenticated ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt>Frontend token</dt>
              <dd>{frontendToken ? "present" : "missing"}</dd>
            </div>
            <div>
              <dt>URL params cleaned</dt>
              <dd>{window.location.search ? window.location.search : "clean"}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <p className="eyebrow">Environment</p>
          <dl className="facts">
            <div>
              <dt>Platform</dt>
              <dd>{getMentraOSPlatform() ?? "browser"}</dd>
            </div>
            <div>
              <dt>In Mentra webview</dt>
              <dd>{isInMentraOS() ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt>Cookie probe</dt>
              <dd>{cookieProbe?.hasCookie ? "session cookie present" : "waiting"}</dd>
            </div>
            <div>
              <dt>Runtime session</dt>
              <dd>
                {cookieProbe?.runtimeSessionId
                  ? `${cookieProbe.runtimeStatus} (${cookieProbe.runtimeSessionId})`
                  : (cookieProbe?.runtimeStatus ?? "waiting")}
              </dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="grid">
        <article className="panel">
          <p className="eyebrow">Cookie auth route</p>
          <pre>{JSON.stringify(cookieProbe, null, 2)}</pre>
        </article>

        <article className="panel">
          <p className="eyebrow">Frontend token route</p>
          <pre>{JSON.stringify(tokenProbe, null, 2)}</pre>
        </article>
      </section>

      <section className="panel">
        <p className="eyebrow">Developer check</p>
        <p className="muted">
          Edit this file while `bun run dev` is running. Bun should hot-reload the UI without losing the mounted app
          shell.
        </p>
        {probeError ? <p className="error">{probeError}</p> : null}
      </section>
    </main>
  );
}
