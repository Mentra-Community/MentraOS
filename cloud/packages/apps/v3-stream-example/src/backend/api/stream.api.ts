import { Hono } from "hono";
import { getMentraAuth } from "@mentra/sdk";
import { UserSession } from "../session/UserSession";

const app = new Hono();

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/", getStreamInfo);
app.post("/start/managed", startManaged);
app.post("/start/direct", startDirect);
app.post("/stop", stopStream);

// ─── Handlers ────────────────────────────────────────────────────────────────

function getStreamInfo(c: any) {
  const userSession = resolveUserSession(c);
  if (!userSession) {
    return c.json({
      active: false,
      mode: null,
      url: null,
      startedAt: null,
      status: "not authenticated",
      error: null,
      hlsUrl: null,
      dashUrl: null,
      webrtcUrl: null,
      previewUrl: null,
      streamId: null,
    });
  }

  return c.json(userSession.stream.getSnapshot());
}

async function startManaged(c: any) {
  const userSession = resolveUserSession(c);
  if (!userSession) {
    return c.json({ ok: false, error: "Not authenticated" });
  }

  const urls = await userSession.stream.startManaged();

  if (urls) {
    return c.json({ ok: true, ...urls });
  }
  // Log the snapshot error if no URLs are returned.
  userSession.appSession?.logger.error("Failed to start managed stream");

  const snapshot = userSession.stream.getSnapshot();
  userSession.appSession?.logger.error(
    { snapshot },
    "Failed to start managed stream 2",
  );

  return c.json({
    ok: false,
    error: snapshot.error || "Failed to start managed stream",
  });
}

async function startDirect(c: any) {
  const userSession = resolveUserSession(c);
  if (!userSession) {
    return c.json({ ok: false, error: "Not authenticated" });
  }

  let streamUrl: string;
  try {
    const body = await c.req.json();
    streamUrl = body.url;
  } catch {
    streamUrl = process.env.STREAM_URL || "";
  }

  if (!streamUrl) {
    return c.json({ ok: false, error: "No stream URL provided" });
  }

  await userSession.stream.startDirect(streamUrl);

  const snapshot = userSession.stream.getSnapshot();
  if (snapshot.active) {
    return c.json({ ok: true });
  }

  return c.json({
    ok: false,
    error: snapshot.error || "Failed to start direct stream",
  });
}

async function stopStream(c: any) {
  const userSession = resolveUserSession(c);
  if (!userSession) {
    return c.json({ ok: false, error: "Not authenticated" });
  }

  await userSession.stream.stop();
  return c.json({ ok: true });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveUserSession(c: any): UserSession | undefined {
  const auth = getMentraAuth(c);
  const userId = auth?.userId;
  if (!userId) return undefined;
  return UserSession.get(userId);
}

export default app;
