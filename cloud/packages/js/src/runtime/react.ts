/**
 * @mentra/js/react — React hooks for webview/ code
 *
 * import { useMentra } from "@mentra/js/react";
 */

import { useState, useEffect, useRef } from "react";

interface MentraHookResult {
  state: Record<string, any>;
  connected: boolean;
}

export function useMentra(): MentraHookResult {
  const [appState, setAppState] = useState<Record<string, any>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;

      source = new EventSource("/__mentra/state");

      source.onopen = () => {
        setConnected(true);
      };

      source.onerror = () => {
        setConnected(false);
        source?.close();
        // Retry after 1s
        if (!disposed) setTimeout(connect, 1000);
      };

      source.addEventListener("snapshot", (e) => {
        try {
          setAppState(JSON.parse((e as MessageEvent).data));
        } catch {}
      });

      source.addEventListener("update", (e) => {
        try {
          const newState = JSON.parse((e as MessageEvent).data);
          setAppState(newState);
        } catch {}
      });
    }

    connect();

    return () => {
      disposed = true;
      source?.close();
    };
  }, []);

  return { state: appState, connected };
}

export function useMentraState<T = any>(key: string): T {
  const { state } = useMentra();
  return state[key] as T;
}
