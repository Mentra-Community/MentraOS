import { Hono } from "hono";
import { z } from "zod";
import {
  exchangeAcsTeamsUserToken,
  verifyTeamsSubjectToken,
} from "../services/meetings/acs-teams.service";
import { authenticateRuntimeRequest } from "./runtime-auth";

const exchangeRequestSchema = z
  .object({ teamsUserAadToken: z.string().min(100).max(16_384) })
  .strict();

export const meetingsApi = new Hono();

meetingsApi.post("/acs/teams-user-token", async (c) => {
  const auth = await authenticateRuntimeRequest(c);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = exchangeRequestSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "invalid Teams token exchange request" }, 400);

  try {
    const subject = await verifyTeamsSubjectToken(
      parsed.data.teamsUserAadToken,
      {
        tenantId: auth.identity.tenantId,
        objectId: auth.identity.mentraUserId,
      },
    );
    return c.json(await exchangeAcsTeamsUserToken(subject), 200);
  } catch {
    // Never return provider details: they can contain token fragments or
    // customer resource identifiers. Operators retain structured server logs.
    return c.json({ error: "Teams identity exchange rejected" }, 403);
  }
});
