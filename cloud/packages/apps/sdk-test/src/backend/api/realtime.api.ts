import {Hono} from "hono"
import type {Context} from "hono"
import {UserSession} from "../UserSession"

const app = new Hono()

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/start", startRealtime)
app.post("/stop", stopRealtime)
app.post("/interrupt", interruptRealtime)
app.get("/status", getStatus)

// ─── Handlers ────────────────────────────────────────────────────────────────

/** POST /start — begin a realtime conversation session (OpenAI or Gemini) */
async function startRealtime(c: Context) {
  const {userId, provider, voice, systemPrompt} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession) {
    return c.json({error: `No session for user ${userId}. Are the glasses connected?`}, 404)
  }

  if (!userSession.appSession) {
    return c.json({error: "Glasses are not connected. Please reconnect and try again."}, 503)
  }

  if (userSession.realtime.isActive) {
    return c.json({error: "Realtime session already active"}, 409)
  }

  try {
    await userSession.realtime.start({provider, voice, systemPrompt})
    return c.json({
      success: true,
      message: `Realtime session started (${provider || "gemini"})`,
      userId,
      provider: userSession.realtime.currentProvider,
    })
  } catch (error: any) {
    console.error("[realtime.api] Failed to start:", error.message)

    // Categorize the error for the frontend
    if (error.message.includes("disconnected during")) {
      return c.json({error: "Glasses disconnected during setup. Please reconnect and try again."}, 503)
    }
    if (error.message.includes("timed out")) {
      return c.json({error: `AI provider connection timed out. Please try again.`}, 504)
    }
    if (error.message.includes("not found") || error.message.includes("not supported")) {
      return c.json({error: `AI model unavailable: ${error.message}`}, 502)
    }

    return c.json({error: error.message}, 500)
  }
}

/** POST /stop — end the realtime conversation session */
async function stopRealtime(c: Context) {
  const {userId} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession) {
    return c.json({error: `No user for ${userId}`}, 404)
  }

  if (!userSession.realtime.isActive) {
    // Not an error — session may have been cleaned up by a disconnect.
    // Return success so the frontend can reset its state cleanly.
    return c.json({success: true, message: "No active realtime session (already stopped)", userId})
  }

  try {
    await userSession.realtime.stop()
    return c.json({success: true, message: "Realtime session stopped", userId})
  } catch (error: any) {
    console.error("[realtime.api] Failed to stop:", error.message)
    return c.json({error: error.message}, 500)
  }
}

/** POST /interrupt — flush AI audio output (user wants to talk) */
async function interruptRealtime(c: Context) {
  const {userId} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession) {
    return c.json({error: `No user for ${userId}`}, 404)
  }

  if (!userSession.realtime.isActive) {
    return c.json({error: "No active realtime session"}, 409)
  }

  try {
    await userSession.realtime.interrupt()
    return c.json({success: true, message: "Realtime session interrupted", userId})
  } catch (error: any) {
    console.error("[realtime.api] Failed to interrupt:", error)
    return c.json({error: error.message}, 500)
  }
}

/** GET /status — check whether a realtime session is active */
async function getStatus(c: Context) {
  const userId = c.req.query("userId")

  if (!userId) return c.json({error: "userId query param is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession) {
    return c.json({active: false, reason: "no_session"})
  }

  return c.json({
    active: userSession.realtime.isActive,
    provider: userSession.realtime.currentProvider,
    userId,
  })
}

export default app
