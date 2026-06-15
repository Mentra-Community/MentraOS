/**
 * Debug API
 *
 * Dev-only endpoints for testing session lifecycle. Mounted on
 * the session sub-app, so a valid auth token AND a live User are
 * required just like any other route there.
 */

import { sessions } from "../manager/SessionManager";
import type { SessionContext } from "../utils/auth";

import { broadcastChatEvent, clearPendingEvents } from "./chat";

/**
 * POST /api/debug/kill-session?mode=soft|hard
 *
 * Simulates MentraAI.onStop() for the authenticated user.
 * - mode=soft (default): grace period, keeps session alive for 60s
 * - mode=hard: immediate destroy, wipes everything
 */
export async function killSession(c: SessionContext) {
  const userId = c.get("userId");
  const mode = c.req.query("mode") || "soft";

  if (mode === "hard") {
    broadcastChatEvent(userId, {
      type: "session_ended",
      reason: "debug-hard-kill",
      timestamp: new Date().toISOString(),
    });
    clearPendingEvents(userId);
    sessions.remove(userId);

    return c.json({
      success: true,
      mode: "hard",
      message: "Session hard-killed",
    });
  }

  // Soft kill: grace period (matches real onStop behavior)
  broadcastChatEvent(userId, {
    type: "session_reconnecting",
    reason: "debug-soft-kill",
    timestamp: new Date().toISOString(),
  });
  sessions.softRemove(userId);

  return c.json({
    success: true,
    mode: "soft",
    message: "Session soft-killed (60s grace period)",
  });
}

/**
 * Common handler for the two dev-only sound-test endpoints. Both fire a
 * server-side `playAudio` call exactly the way the real pipeline does
 * (TranscriptionManager.playStartSound, QueryProcessor.startProcessingSound)
 * so we can isolate "is playAudio working in prod?" from "is the wake-word
 * path working?"
 *
 * The URL is derived from PUBLIC_URL the same way the real code does it,
 * so this test produces a result that exactly matches a real activation.
 *
 * NOT gated on NODE_ENV === "development" — debugging prod audio is the
 * whole reason this exists.
 */
async function playAssetSound(
  c: SessionContext,
  assetPath: string,
): Promise<Response> {
  const user = c.get("user");
  if (!user.appSession) {
    return c.json({ error: "No active glasses session" }, 404);
  }

  const base = process.env.PUBLIC_URL;
  if (!base) {
    return c.json({ error: "PUBLIC_URL is not set" }, 500);
  }

  // Refuse to ship a schemeless URL to the phone. playAudio takes the URL
  // verbatim and the phone fetches it directly — without https:// the phone
  // treats it as a relative URL, can't load anything, and reports
  // "Playback failed (player went idle)". Fail loudly here so the wearer
  // sees a real error instead of a confused timeout downstream.
  if (!/^https?:\/\//i.test(base)) {
    const msg = `PUBLIC_URL is missing the http(s):// scheme: "${base}"`;
    console.error(`🔊 [/api/debug/play-sound] ${msg}`);
    return c.json({ error: msg }, 500);
  }

  const url = `${base.replace(/\/$/, "")}${assetPath}`;
  console.log(`🔊 [/api/debug/play-sound] user=${user.userId} url=${url}`);

  const t0 = Date.now();
  try {
    const result = await user.appSession.audio.playAudio({ audioUrl: url });
    const ms = Date.now() - t0;
    console.log(
      `🔊 [/api/debug/play-sound] resolved in ${ms}ms  success=${result?.success}  error=${result?.error ?? "none"}`,
    );
    return c.json({
      success: result?.success ?? true,
      url,
      durationMs: ms,
      playback: {
        success: result?.success ?? null,
        duration: result?.duration ?? null,
        error: result?.error ?? null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`🔊 [/api/debug/play-sound] threw: ${msg}`);
    return c.json({ success: false, url, error: msg }, 500);
  }
}

/** POST /api/debug/play-start — fires /assets/audio/start.mp3 on the glasses. */
export async function playStartSound(c: SessionContext) {
  return playAssetSound(c, "/assets/audio/start.mp3");
}

/** POST /api/debug/play-popping — fires /assets/audio/popping.mp3 on the glasses. */
export async function playPoppingSound(c: SessionContext) {
  return playAssetSound(c, "/assets/audio/popping.mp3");
}
