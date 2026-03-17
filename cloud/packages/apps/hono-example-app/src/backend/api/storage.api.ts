import {Hono} from "hono"
import type {Context} from "hono"
import {UserSession} from "../UserSession"

const app = new Hono()

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/theme", getTheme)
app.post("/theme", setTheme)

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /theme — get user's theme preference */
async function getTheme(c: Context) {
  const userId = c.req.query("userId")

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession?.appSession) {
    return c.json({error: `No active session for user ${userId}`}, 404)
  }

  try {
    const theme = await userSession.storage.getTheme()
    return c.json({theme, userId})
  } catch (error: any) {
    return c.json({error: error.message}, 500)
  }
}

/** POST /theme — set user's theme preference */
async function setTheme(c: Context) {
  const {userId, theme} = await c.req.json()

  if (!userId) return c.json({error: "userId is required"}, 400)
  if (!theme || (theme !== "dark" && theme !== "light")) {
    return c.json({error: 'theme must be "dark" or "light"'}, 400)
  }

  const userSession = UserSession.get(userId)
  if (!userSession?.appSession) {
    return c.json({error: `No active session for user ${userId}`}, 404)
  }

  try {
    await userSession.storage.setTheme(theme)
    return c.json({success: true, theme, userId})
  } catch (error: any) {
    return c.json({error: error.message}, 500)
  }
}

export default app
