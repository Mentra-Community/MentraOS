import {createHmac, timingSafeEqual} from "node:crypto"
import {Hono} from "hono"
import {z} from "zod"
import {findUserByEmail} from "../../services/account/gotrue.client"
import {findOrCreateUser} from "../../services/user.service"
import type {AppEnv} from "../../types/hono.types"

const app = new Hono<AppEnv>()
const requestSchema = z.object({email: z.string().email()})

/**
 * Narrow service-to-service identity bridge. Core remains the only service
 * that maps account-provider identities to opaque Mentra user IDs.
 */
app.post("/resolve-email", async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({error: "invalid_request"}, 400)
  const email = parsed.data.email.trim().toLowerCase()
  if (!authorized(c.req.header("x-mentra-service-timestamp"), c.req.header("x-mentra-service-signature"), email)) {
    return c.json({error: "unauthorized"}, 401)
  }
  const identity = await findUserByEmail(email)
  if (!identity?.emailVerified) return c.json({error: "not_found"}, 404)
  const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: identity.id})
  return c.json({mentraUserId: user.mentraUserId})
})

function authorized(timestamp: string | undefined, supplied: string | undefined, email: string): boolean {
  const secret = (process.env.MENTRA_SERVICE_AUTH_SECRET ?? process.env.WORKOS_API_KEY)?.trim()
  if (!secret || !timestamp || !supplied) return false
  const timestampMs = Number(timestamp)
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) return false
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${email}`).digest("base64url")
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export default app
