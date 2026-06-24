/**
 * API Route Definitions
 *
 * Three sub-apps mounted at /api:
 *
 *   publicApi     reachable without auth
 *   protectedApi  authenticated, no live session needed
 *                 (DB-backed reads/writes that work whether or
 *                 not glasses are currently connected)
 *   sessionApi    authenticated AND live User; handlers read
 *                 c.get("user") directly
 *
 * New routes pick the sub-app that matches what they need. See
 * issues/auth-by-default for the rationale.
 */

import { Hono } from "hono";

import { agentWebhook } from "../api/agentWebhook";
import { speak, stopAudio } from "../api/audio";
import { chatSend, chatStream } from "../api/chat";
import { killSession, playPoppingSound, playStartSound } from "../api/debug";
import { getHealth } from "../api/health";
import { getLatestPhoto, getPhotoData, getPhotoBase64 } from "../api/photo";
import { getSettings, updateSettings } from "../api/settings";
import { getThemePreference, setThemePreference } from "../api/storage";
import { photoStream, transcriptionStream } from "../api/stream";
import type { User } from "../session/User";
import { requireAuth, requireSession } from "../utils/auth";

// Disable proxy buffering on SSE so Nginx/ingress forwards data
// immediately. Without this, heartbeats get stuck in Nginx's
// response buffer and the proxy considers the connection idle
// after its read timeout (~60s), killing the SSE.
const sseHeaders = async (c: any, next: any) => {
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache, no-transform");
  await next();
};

// ── Public ─────────────────────────────────────────────────────────
//
// Reachable without an auth token. Keep this list short and
// deliberate. Anything that touches user state belongs further
// down.

const publicApi = new Hono();
publicApi.get("/health", getHealth);

// Giga-agent delegation callback (server-to-server). Public by design — it
// carries no SDK user token; the handler verifies the shared x-api-key instead.
publicApi.post("/agent/webhook", agentWebhook);

// ── Auth-only ──────────────────────────────────────────────────────
//
// Authenticated, but does not require glasses to be connected.
// DB-backed reads/writes go here.

const protectedApi = new Hono<{ Variables: { userId: string } }>();
protectedApi.use("*", requireAuth);

protectedApi.get("/settings", getSettings);
protectedApi.patch("/settings", updateSettings);

// Chat works without glasses (webview text box for testing + reading history),
// so the stream and send live here, not behind requireSession.
protectedApi.use("/chat/stream", sseHeaders);
protectedApi.get("/chat/stream", chatStream);
protectedApi.post("/chat/send", chatSend);

// ── Session-required ───────────────────────────────────────────────
//
// Authenticated AND a live User exists in the SessionManager.
// Handlers read c.get("user") and trust it is non-null. Returns
// 404 if the user is not currently tracked.

const sessionApi = new Hono<{
  Variables: { userId: string; user: User };
}>();
sessionApi.use("*", requireAuth);
sessionApi.use("*", requireSession);

sessionApi.use("/photo-stream", sseHeaders);
sessionApi.use("/transcription-stream", sseHeaders);

sessionApi.get("/photo-stream", photoStream);
sessionApi.get("/transcription-stream", transcriptionStream);

sessionApi.post("/speak", speak);
sessionApi.post("/stop-audio", stopAudio);

sessionApi.get("/theme-preference", getThemePreference);
sessionApi.post("/theme-preference", setThemePreference);

sessionApi.get("/latest-photo", getLatestPhoto);
sessionApi.get("/photo/:requestId", getPhotoData);
sessionApi.get("/photo-base64/:requestId", getPhotoBase64);

if (process.env.NODE_ENV === "development") {
  sessionApi.post("/debug/kill-session", killSession);
}

// Sound test endpoints — kept available in prod because the whole point
// is verifying playAudio works in prod (where it has been flaky).
sessionApi.post("/debug/play-start", playStartSound);
sessionApi.post("/debug/play-popping", playPoppingSound);

export const api = new Hono();
api.route("/", publicApi);
api.route("/", protectedApi);
api.route("/", sessionApi);
