import {Hono} from "hono"
import {z} from "zod"
import {
  AcsCredentialError,
  exchangeAcsTeamsUserToken,
  mintAcsGuestToken,
  TeamsIdentityRejectedError,
  verifyTeamsSubjectToken,
} from "../services/meetings/acs-teams.service"
import {authenticateRuntimeRequest} from "./runtime-auth"

const MAX_CREDENTIAL_REQUEST_BYTES = 16 * 1024
const credentialRequestSchema = z.object({teamsUserAadToken: z.string().min(100).max(16_384).optional()}).strict()

class CredentialRequestTooLargeError extends Error {}

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
    return c.json({error: "ACS credential request is too large"}, 413)
  }
  let body: unknown = {}
  try {
    const text = await readCredentialRequestBody(c.req.raw)
    if (text.trim()) body = JSON.parse(text)
  } catch (error) {
    if (error instanceof CredentialRequestTooLargeError) {
      return c.json({error: "ACS credential request is too large"}, 413)
    }
    return c.json({error: "invalid JSON body"}, 400)
  }
  const parsed = credentialRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({error: "invalid ACS credential request"}, 400)

  if (!parsed.data.teamsUserAadToken) {
    try {
      return c.json(await mintAcsGuestToken(`${auth.identity.tenantId}:${auth.identity.mentraUserId}`), 200)
    } catch (error) {
      if (error instanceof AcsCredentialError) {
        return c.json({error: error.message}, error.status)
      }
      console.error("ACS guest credential unavailable", error)
      return c.json({error: "Teams meeting provider unavailable"}, 502)
    }
  }

  const federated = auth.identity.federatedIdentity
  if (!federated || federated.providerKind !== "microsoft-entra" || !federated.directoryTenantId) {
    return c.json({error: "Teams identity exchange rejected"}, 403)
  }
  const configuredTenantId = process.env.ENTRA_TENANT_ID?.trim()
  if (!configuredTenantId) {
    return c.json({error: "Microsoft Teams employee identity is not configured"}, 503)
  }
  if (federated.issuer !== `https://login.microsoftonline.com/${configuredTenantId}/v2.0`) {
    return c.json({error: "Teams identity exchange rejected"}, 403)
  }

  let subject
  try {
    subject = await verifyTeamsSubjectToken(parsed.data.teamsUserAadToken, {
      tenantId: federated.directoryTenantId,
      objectId: federated.subject,
    })
  } catch (error) {
    if (error instanceof AcsCredentialError) {
      return c.json({error: error.message}, error.status)
    }
    if (!(error instanceof TeamsIdentityRejectedError)) {
      console.error("Teams identity provider unavailable", error)
      return c.json({error: "Teams identity provider unavailable"}, 503)
    }
    return c.json({error: "Teams identity exchange rejected"}, 403)
  }

  try {
    return c.json(await exchangeAcsTeamsUserToken(subject), 200)
  } catch (error) {
    if (error instanceof AcsCredentialError) {
      return c.json({error: error.message}, error.status)
    }
    console.error("ACS token exchange unavailable", error)
    return c.json({error: "Teams meeting provider unavailable"}, 502)
  }
})
