import { Hono } from "hono";
import { getMentraAuth } from "@mentra/sdk";
import { UserSession } from "../session/UserSession";

const app = new Hono();

/**
 * SSE endpoint — streams state updates to the frontend.
 * Client connects with EventSource("/api/state/stream").
 */
app.get("/stream", (c: any) => {
  const auth = getMentraAuth(c);
  const userId = auth?.userId;
  if (!userId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  // Use getOrCreate so the SSE connection works even before the glasses
  // session webhook fires (e.g. browser reconnects faster than glasses
  // after a server restart). When the glasses do connect, attachSession()
  // populates the same UserSession and pushState() broadcasts to this SSE.
  const userSession = UserSession.getOrCreate(userId);

  const encoder = new TextEncoder();
  let cleaned = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      unsubscribe = userSession.state.subscribe(send);

      // Keep-alive ping every 30s
      pingInterval = setInterval(() => {
        send("ping", JSON.stringify({ ts: Date.now() }));
      }, 30_000);
    },
    cancel() {
      cleanup();
    },
  });

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    unsubscribe?.();
    if (pingInterval) clearInterval(pingInterval);
  }

  // Clean up on client disconnect
  c.req.raw.signal?.addEventListener("abort", cleanup);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export default app;
