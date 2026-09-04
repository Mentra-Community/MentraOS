import {Hono} from "hono"
import {z} from "zod"
import {
  exchangeAcsTeamsUserToken,
  TeamsIdentityRejectedError,
  verifyTeamsSubjectToken,
} from "../services/meetings/acs-teams.service"
import {authenticateRuntimeRequest} from "./runtime-auth"

const exchangeRequestSchema = z.object({teamsUserAadToken: z.string().min(100).max(16_384)}).strict()

export const meetingsApi = new Hono()

meetingsApi.post("/acs/teams-user-token", async (c) => {
  const auth = await authenticateRuntimeRequest(c)
  if ("error" in auth) return auth.error

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({error: "invalid JSON body"}, 400)
  }
  const parsed = exchangeRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({error: "invalid Teams token exchange request"}, 400)

  const federated = auth.identity.federatedIdentity
  if (
    !federated ||
    federated.providerKind !== "microsoft-entra" ||
    federated.issuer !== `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0` ||
    !federated.directoryTenantId
  ) {
    return c.json({error: "Teams identity exchange rejected"}, 403)
  }

  let subject
  try {
    subject = await verifyTeamsSubjectToken(parsed.data.teamsUserAadToken, {
      tenantId: federated.directoryTenantId,
      objectId: federated.subject,
    })
  } catch (error) {
    if (!(error instanceof TeamsIdentityRejectedError)) {
      console.error("Teams identity provider unavailable", error)
      return c.json({error: "Teams identity provider unavailable"}, 503)
    }
    return c.json({error: "Teams identity exchange rejected"}, 403)
  }

  try {
    return c.json(await exchangeAcsTeamsUserToken(subject), 200)
  } catch (error) {
    console.error("ACS token exchange unavailable", error)
    return c.json({error: "Teams meeting provider unavailable"}, 502)
  }
})
