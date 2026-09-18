import {createHmac, timingSafeEqual} from "node:crypto"
import {Hono} from "hono"
import {z} from "zod"
import {DeveloperSigningService, DeveloperSigningServiceError} from "../../services/miniapps/developer-signing.service"
import type {AppEnv} from "../../types/hono.types"

const app = new Hono<AppEnv>()
const signing = new DeveloperSigningService()
const schema = z.object({
  packageName: z.string().min(1),
  attestation: z.object({
    packageName: z.string(),
    devServerUrl: z.string(),
    nonce: z.string(),
    expiresAt: z.string(),
    signingKeyId: z.string(),
    signature: z.string(),
  }),
})

app.post("/verify", async (c) => {
  const raw = await c.req.text()
  if (!authorized(c.req.header("x-mentra-service-timestamp"), c.req.header("x-mentra-service-signature"), raw)) {
    return c.json({error: "unauthorized"}, 401)
  }
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return c.json({error: "invalid_request"}, 400)
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) return c.json({error: "invalid_request"}, 400)
  try {
    await signing.verifyDevAttestation(parsed.data.packageName, parsed.data.attestation)
    return c.json({valid: true})
  } catch (error) {
    if (error instanceof DeveloperSigningServiceError) {
      return c.json({error: error.code, error_description: error.message}, error.status as 400)
    }
    throw error
  }
})

function authorized(timestamp: string | undefined, supplied: string | undefined, body: string): boolean {
  const secret = (process.env.MENTRA_SERVICE_AUTH_SECRET ?? process.env.WORKOS_API_KEY)?.trim()
  if (!secret || !timestamp || !supplied) return false
  const time = Number(timestamp)
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 60_000) return false
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${body}`).digest("base64url")
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export default app
