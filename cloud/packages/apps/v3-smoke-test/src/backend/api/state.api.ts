import { getMentraAuth, type AuthVariables, type MentraAuthHonoContext } from "@mentra/sdk";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { UserSession } from "../UserSession";
import type { AppState, AppStateKey } from "../../shared/state";
import { isAppStateKey } from "../../shared/state";

const app = new Hono<{ Variables: AuthVariables }>();

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/snapshot", snapshot);
app.get("/stream", stream);
app.post("/set", setState);

// ─── Handlers ────────────────────────────────────────────────────────────────

function snapshot(c: Context<{ Variables: AuthVariables }>) {
  const resolved = requireUserSession(c as MentraAuthHonoContext);
  if (resolved instanceof Response) {
    return resolved;
  }

  return c.json(resolved.userSession.getSnapshot());
}

function stream(c: Context<{ Variables: AuthVariables }>) {
  const resolved = requireUserSession(c as MentraAuthHonoContext);
  if (resolved instanceof Response) {
    return resolved;
  }

  const { userSession } = resolved;

  return streamSSE(c, async (streamResponse: any) => {
    const client = {
      close: () => streamResponse.close(),
      send: async (event: "ping" | "runtime_update" | "snapshot" | "state_update", payload: unknown) => {
        await streamResponse.writeSSE({
          data: JSON.stringify(payload),
          event,
        });
      },
    };

    userSession.addStateClient(client);
    await userSession.sendSnapshot(client);

    streamResponse.onAbort(() => {
      userSession.removeStateClient(client);
    });

    while (true) {
      await streamResponse.sleep(15000);
      await userSession.sendPing(client);
    }
  });
}

async function setState(c: Context<{ Variables: AuthVariables }>) {
  const resolved = requireUserSession(c as MentraAuthHonoContext);
  if (resolved instanceof Response) {
    return resolved;
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    key?: string;
    value?: unknown;
  };

  if (!body.key || !isAppStateKey(body.key)) {
    return c.json({ error: "Invalid state key" }, 400);
  }

  const key = body.key as AppStateKey;
  resolved.userSession.setState(key, body.value as AppState[typeof key], "webview");

  return c.json({
    ok: true,
    snapshot: resolved.userSession.getSnapshot(),
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireUserSession(c: MentraAuthHonoContext): { userId: string; userSession: UserSession } | Response {
  const auth = getMentraAuth(c);
  if (!auth.userId) {
    return c.json({ error: "Unauthenticated" }, 401);
  }

  const userSession = UserSession.get(auth.userId);
  if (!userSession) {
    return c.json({ error: "No active user session" }, 404);
  }

  return {
    userId: auth.userId,
    userSession,
  };
}

export default app;
