import { useEffect, useRef, useState } from "react";
import { type AppState, DEFAULT_APP_STATE } from "../shared/state";

const MAX_RETRY_MS = 10_000;

/**
 * Subscribes to backend state via SSE.
 * Returns live AppState + connection status.
 * Only connects when `enabled` is true (i.e. user is authenticated).
 *
 * @param frontendToken — passed as query param for cookie-less auth
 *   (EventSource doesn't support custom headers, so we can't use Authorization).
 *   The SDK auth middleware already accepts `aos_frontend_token` as a query param.
 */
export function useAppState(enabled: boolean, frontendToken?: string | null) {
  const [state, setState] = useState<AppState>(DEFAULT_APP_STATE);
  const [isConnected, setIsConnected] = useState(false);
  const retryMs = useRef(1000);

  useEffect(() => {
    if (!enabled) {
      setState(DEFAULT_APP_STATE);
      setIsConnected(false);
      return;
    }

    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (disposed) return;

      const params = frontendToken
        ? `?aos_frontend_token=${encodeURIComponent(frontendToken)}`
        : "";
      source = new EventSource(`/api/state/stream${params}`, {
        withCredentials: true,
      });

      source.onopen = () => {
        retryMs.current = 1000;
        setIsConnected(true);
      };

      source.onerror = () => {
        source?.close();
        source = null;
        setIsConnected(false);
        if (!disposed) {
          const delay = retryMs.current;
          retryMs.current = Math.min(delay * 2, MAX_RETRY_MS);
          retryTimer = setTimeout(connect, delay);
        }
      };

      source.addEventListener("snapshot", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as AppState;
          setState(data);
        } catch {
          // silently discard unparseable payloads
        }
      });

      source.addEventListener("update", (e) => {
        try {
          const { key, value } = JSON.parse((e as MessageEvent).data);
          setState((prev) => ({ ...prev, [key]: value }));
        } catch {
          // silently discard unparseable payloads
        }
      });
    }

    connect();

    return () => {
      disposed = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, frontendToken]);

  return { state, isConnected };
}
