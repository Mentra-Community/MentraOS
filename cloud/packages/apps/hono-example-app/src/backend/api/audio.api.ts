import {Hono} from "hono"
import type {Context} from "hono"
import {UserSession} from "../UserSession"

const app = new Hono()

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/speak", speak)
app.post("/stop", stopAudio)

// ─── Handlers ────────────────────────────────────────────────────────────────

/** POST /speak — text-to-speech on the glasses */
async function speak(c: Context) {
  const {text, userId} = await c.req.json()

  if (!text) return c.json({error: "text is required"}, 400)
  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession?.appSession) {
    return c.json({error: `No active session for user ${userId}`}, 404)
  }

  try {
    await userSession.audio.speak(text)
    return c.json({success: true, message: "Text-to-speech started", userId})
  } catch (error: any) {
    return c.json({error: error.message}, 500)
  }
}

/** POST /stop — stop audio playback */
async function stopAudio(c: Context) {
  const {userId} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession?.appSession) {
    return c.json({error: `No active session for user ${userId}`}, 404)
  }

  try {
    await userSession.audio.stopAudio()
    return c.json({success: true, message: "Audio stopped", userId})
  } catch (error: any) {
    return c.json({error: error.message}, 500)
  }
}

export default app
