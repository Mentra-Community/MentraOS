import {Hono} from "hono"
import {z} from "zod"
import {SupportProfileAccountDeletedError, updateSupportProfile} from "../../services/support-profile.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidGrant, InvalidRequest} from "../../types/oauth.types"
import {UserModel} from "../../models/user.model"
import {userAuth} from "../middleware/user-auth.middleware"

const app = new Hono<AppEnv>()
const MAX_BODY_BYTES = 16 * 1024
const safeText = z.string().trim().min(1).max(128)
const safeCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/)

const supportStateSchema = z
  .object({
    observedAt: z.string().datetime({offset: true}),
    host: z
      .object({
        appVersion: safeText.optional(),
        appBuild: safeText.optional(),
        engineVersion: safeText.optional(),
        bluetoothSdkVersion: safeText.optional(),
        phonePlatform: z.enum(["ios", "android", "unknown"]),
        phoneModel: safeText.optional(),
        phoneOsVersion: safeText.optional(),
        connectionState: z.enum(["disconnected", "scanning", "connecting", "bonding", "connected"]),
        failureCode: safeCode.optional(),
        failureStage: safeCode.optional(),
      })
      .strict(),
    device: z
      .object({
        // Accepted only so the server can derive a keyed identifier. The service
        // immediately discards this value; neither Mongo nor PostHog receives it.
        hardwareId: z.string().trim().min(1).max(256).optional(),
        model: safeText.optional(),
        androidVersion: safeText.optional(),
        firmwareVersion: safeText.optional(),
        mtkFirmwareVersion: safeText.optional(),
        besFirmwareVersion: safeText.optional(),
        appVersion: safeText.optional(),
        buildNumber: safeText.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

app.use("*", userAuth)
app.put("/", putSupportProfile)

async function putSupportProfile(c: AppContext) {
  const contentLength = Number.parseInt(c.req.header("content-length") ?? "0", 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new InvalidRequest("support profile payload is too large")
  }
  const text = await readBodyCapped(c.req.raw)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new InvalidRequest("request body must be valid JSON")
  }
  const parsed = supportStateSchema.safeParse(body)
  if (!parsed.success) {
    throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid support profile payload")
  }
  const observedAt = new Date(parsed.data.observedAt)
  if (!Number.isFinite(observedAt.getTime())) {
    throw new InvalidRequest("observedAt must be a valid timestamp")
  }
  const now = Date.now()
  if (observedAt.getTime() > now + 5 * 60_000 || observedAt.getTime() < now - 30 * 24 * 60 * 60_000) {
    throw new InvalidRequest("observedAt is outside the accepted window")
  }
  const user = c.var.user!
  const activeUser = await UserModel.exists({
    mentraUserId: user.mentraUserId,
    supportTelemetryDeletedAt: null,
  })
  if (!activeUser) throw new InvalidGrant("account is deleted")
  try {
    return c.json(await updateSupportProfile({mentraUserId: user.mentraUserId, tenantId: user.tenantId}, parsed.data))
  } catch (error) {
    if (error instanceof SupportProfileAccountDeletedError) throw new InvalidGrant("account is deleted")
    throw error
  }
}

async function readBodyCapped(request: Request): Promise<string> {
  if (!request.body) return ""
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new InvalidRequest("support profile payload is too large")
    }
    text += decoder.decode(value, {stream: true})
  }
  return text + decoder.decode()
}

export default app
