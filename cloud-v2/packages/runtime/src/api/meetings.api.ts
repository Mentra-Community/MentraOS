import {Hono} from "hono"
import {z} from "zod"
import type {VerifiedAccessToken} from "@mentra/cloud-shared"
import {
  AcsCredentialError,
  issueAcsTeamsCredential,
  mintAcsGuestToken,
  TeamsIdentityRejectedError,
  bindTeamsSubject,
} from "../services/meetings/acs-teams.service"
import {createTeamsMeeting, retireTeamsMeeting, TeamsMeetingError} from "../services/meetings/teams-meetings.service"
import {authenticateRuntimeRequest} from "./runtime-auth"

const MAX_CREDENTIAL_REQUEST_BYTES = 16 * 1024
const credentialRequestSchema = z.object({teamsUserAadToken: z.string().min(100).max(16_384).optional()}).strict()
const createRequestSchema = credentialRequestSchema.extend({
  subject: z.string().trim().min(1).max(120).default("Mentra Call"),
  durationMinutes: z.number().int().min(1).max(1440).default(30),
})
const retireRequestSchema = z.object({meetingRef: z.string().min(1).max(8192)}).strict()

class CredentialRequestTooLargeError extends Error {}
class InvalidMeetingRequestError extends Error {}

async function readMeetingJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse((await readCredentialRequestBody(request)) || "{}")
  } catch (error) {
    if (error instanceof CredentialRequestTooLargeError) throw error
    throw new InvalidMeetingRequestError()
  }
}

async function readCredentialRequestBody(request: Request): Promise<string> {
  if (!request.body) return ""

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_CREDENTIAL_REQUEST_BYTES) {
        await reader.cancel("credential request exceeds byte limit")
        throw new CredentialRequestTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", {fatal: true}).decode(body)
}

export const meetingsApi = new Hono()

meetingsApi.post("/acs/token", async (c) => {
  const auth = await authenticateRuntimeRequest(c)
  if ("error" in auth) return auth.error

  const contentLength = Number.parseInt(c.req.header("content-length") ?? "0", 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_CREDENTIAL_REQUEST_BYTES) {
    return c.json(meetingError("ACS credential request is too large"), 413)
  }
  let body: unknown = {}
  try {
    const text = await readCredentialRequestBody(c.req.raw)
    if (text.trim()) body = JSON.parse(text)
  } catch (error) {
    if (error instanceof CredentialRequestTooLargeError) {
      return c.json(meetingError("ACS credential request is too large"), 413)
    }
    return c.json(meetingError("invalid JSON body"), 400)
  }
  const parsed = credentialRequestSchema.safeParse(body)
  if (!parsed.success) return c.json(meetingError("invalid ACS credential request"), 400)

  if (!parsed.data.teamsUserAadToken) {
    try {
      return c.json(await mintAcsGuestToken(`${auth.identity.tenantId}:${auth.identity.mentraUserId}`), 200)
    } catch (error) {
      if (error instanceof AcsCredentialError) {
        return c.json(meetingError(error.message), error.status)
      }
      console.error("ACS guest credential unavailable", error)
      return c.json(meetingError("Teams meeting provider unavailable"), 502)
    }
  }

  let subject
  try {
    subject = await boundSubject(auth.identity, parsed.data.teamsUserAadToken)
  } catch (error) {
    if (error instanceof AcsCredentialError) {
      return c.json(meetingError(error.message), error.status)
    }
    if (!(error instanceof TeamsIdentityRejectedError)) {
      console.error("Teams identity provider unavailable", error)
      return c.json(meetingError("Teams identity provider unavailable"), 503)
    }
    return c.json(meetingError(error.message, "Teams identity exchange rejected"), 403)
  }

  try {
    return c.json(
      await issueAcsTeamsCredential(subject, `${auth.identity.tenantId}:${auth.identity.mentraUserId}`),
      200,
    )
  } catch (error) {
    if (error instanceof TeamsIdentityRejectedError)
      return c.json(meetingError(error.message, "Teams identity exchange rejected"), 403)
    if (error instanceof AcsCredentialError) {
      return c.json(meetingError(error.message), error.status)
    }
    console.error("ACS token exchange unavailable")
    return c.json(meetingError("Teams meeting provider unavailable"), 502)
  }
})

meetingsApi.post("/teams/create", async (c) => {
  const auth = await authenticateRuntimeRequest(c)
  if ("error" in auth) return auth.error
  try {
    const parsed = createRequestSchema.safeParse(await readMeetingJson(c.req.raw))
    if (!parsed.success) return c.json(meetingError("invalid Teams meeting request"), 400)
    const subject = parsed.data.teamsUserAadToken
      ? await boundSubject(auth.identity, parsed.data.teamsUserAadToken)
      : undefined
    return c.json(
      await createTeamsMeeting({
        actor: meetingActor(auth.identity),
        subject,
        title: parsed.data.subject,
        durationMinutes: parsed.data.durationMinutes,
      }),
    )
  } catch (error) {
    if (error instanceof CredentialRequestTooLargeError)
      return c.json(meetingError("meeting request is too large"), 413)
    if (error instanceof InvalidMeetingRequestError) return c.json(meetingError("invalid meeting request"), 400)
    if (error instanceof TeamsIdentityRejectedError)
      return c.json(meetingError(error.message, "Teams identity exchange rejected"), 403)
    if (error instanceof TeamsMeetingError || error instanceof AcsCredentialError)
      return c.json(meetingError(error.message), error.status)
    return c.json(meetingError("Teams meeting provider unavailable"), 502)
  }
})

meetingsApi.post("/teams/retire", async (c) => {
  const auth = await authenticateRuntimeRequest(c)
  if ("error" in auth) return auth.error
  try {
    const parsed = retireRequestSchema.safeParse(await readMeetingJson(c.req.raw))
    if (!parsed.success) return c.json(meetingError("invalid meeting ownership reference"), 400)
    await retireTeamsMeeting(meetingActor(auth.identity), parsed.data.meetingRef)
    return c.json({retired: true})
  } catch (error) {
    if (error instanceof CredentialRequestTooLargeError)
      return c.json(meetingError("meeting request is too large"), 413)
    if (error instanceof InvalidMeetingRequestError) return c.json(meetingError("invalid meeting request"), 400)
    if (error instanceof TeamsMeetingError) return c.json(meetingError(error.message), error.status)
    return c.json(meetingError("Teams meeting provider unavailable"), 502)
  }
})

// Keep the existing error field for older clients; message is surfaced by
// Cloud Client in the SDK/UI instead of a bare HTTP status. Only call this
// with the bounded errors below, never raw Microsoft/provider responses.
function meetingError(message: string, error = message) {
  return {error, message}
}

function meetingActor(identity: VerifiedAccessToken): string {
  return JSON.stringify([identity.tenantId, identity.mentraUserId])
}

async function boundSubject(identity: VerifiedAccessToken, token: string) {
  const federated = identity.federatedIdentity
  if (!federated || federated.providerKind !== "microsoft-entra" || !federated.directoryTenantId) {
    throw new TeamsIdentityRejectedError("Teams identity exchange rejected")
  }
  const configuredTenantId = process.env.ENTRA_TENANT_ID?.trim()
  if (!configuredTenantId) throw new AcsCredentialError("Microsoft Teams employee identity is not configured", 503)
  if (federated.issuer !== `https://login.microsoftonline.com/${configuredTenantId}/v2.0`) {
    throw new TeamsIdentityRejectedError("Teams identity exchange rejected")
  }
  return bindTeamsSubject(token, {tenantId: federated.directoryTenantId, objectId: federated.subject})
}
