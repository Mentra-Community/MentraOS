import {Hono} from "hono"
import {z} from "zod"
import {exchangeAcsTeamsUserToken, verifyTeamsSubjectToken} from "../services/meetings/acs-teams.service"
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

  try {
    const federated = auth.identity.federatedIdentity
    const expectedIssuer = `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`
    if (
      !federated ||
      federated.providerKind !== "microsoft-entra" ||
      federated.issuer !== expectedIssuer ||
      !federated.directoryTenantId
    ) {
      throw new Error("Runtime session is not bound to the configured Entra identity")
    }
    const subject = await verifyTeamsSubjectToken(parsed.data.teamsUserAadToken, {
      tenantId: federated.directoryTenantId,
      objectId: federated.subject,
    })
    return c.json(await exchangeAcsTeamsUserToken(subject), 200)
  } catch {
    // Never return provider details: they can contain token fragments or
    // customer resource identifiers. Operators retain structured server logs.
    return c.json({error: "Teams identity exchange rejected"}, 403)
  }
})
