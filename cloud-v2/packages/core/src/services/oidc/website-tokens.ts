/**
 * @fileoverview What a miniapp website receives from the token endpoint.
 *
 * Core's sign-in server issues every client an access token for Core's API. A
 * miniapp website must never hold one: its token is the person's miniapp token
 * for the one package the site is registered for, the token the Mentra App
 * gives the miniapp on the phone and the miniapp's backend already verifies.
 *
 * So Core rewrites the token endpoint's answer for a website before it leaves
 * (`api/oidc/oidc.api.ts`): the provider's access token is verified, the checks
 * below run, and the answer carries a freshly minted miniapp token in its
 * place. The ID token and the rotating refresh token pass through.
 *
 * Checked at every issue and every refresh, failing closed:
 *  1. the client is registered and active (a disabled one is no client);
 *  2. the package is not archived in the miniapp registry;
 *  3. a developer's development client signs in only that developer;
 *  4. the website is public, or the person is an active member, with
 *     `miniapps.access`, of a workspace on the client's access list;
 *  5. the person's sign-in still stands (`verifyCoreAccessToken`: not deleted,
 *     not from before their `webSignInsRevokedAt`, source still configured).
 *
 * The miniapp token names the website (`client_id`) and lives five minutes;
 * the site refreshes for the next.
 */

import {capabilitiesForRole, type WorkspaceRole} from "@mentra/workspace-contract"

import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {MiniappTokenUnavailableError, mintMiniappTokenFor} from "../miniapp-token.service"
import {findClient, type OidcClient} from "./clients"
import {verifyCoreAccessToken} from "./core-access-token"
import {packageIsArchived} from "./website-clients.service"

/** How long a website's miniapp token lives. */
export const WEBSITE_TOKEN_TTL_SEC = 5 * 60

export type WebsiteTokenRefusal = "invalid_client" | "invalid_grant" | "access_denied" | "temporarily_unavailable"

/** Whether this person may use the package through this website. */
export async function personMayUseWebsite(client: OidcClient, mentraUserId: string): Promise<boolean> {
  if (!client.website) return false
  if (client.website.onlyUserId && client.website.onlyUserId !== mentraUserId) return false
  // Archiving a miniapp stops its websites too.
  if (await packageIsArchived(client.website.packageName)) return false
  if (client.website.access === "public") return true
  if (client.website.accessWorkspaceIds.length === 0) return false
  const memberships = await WorkspaceMembershipModel.find({
    mentraUserId,
    status: "active",
    workspaceId: {$in: client.website.accessWorkspaceIds},
  })
    .select({_id: 0, role: 1})
    .lean<Array<{role: WorkspaceRole}>>()
  return memberships.some(membership => capabilitiesForRole(membership.role).has("miniapps.access"))
}

/**
 * The token endpoint's answer for a website, from the provider's own. `body` is the provider's JSON for a
 * successful code exchange or refresh by `clientId`.
 */
export async function websiteTokenResponse(
  clientId: string,
  body: Record<string, unknown>,
): Promise<{ok: true; body: Record<string, unknown>} | {ok: false; error: WebsiteTokenRefusal}> {
  const client = await findClient(clientId)
  if (!client?.website) return {ok: false, error: "invalid_client"}
  const providerToken = typeof body.access_token === "string" ? body.access_token : ""
  const identity = providerToken ? await verifyCoreAccessToken(providerToken, {website: true}) : null
  // The token must be the one the provider just issued this client.
  if (!identity || identity.clientId !== client.clientId) return {ok: false, error: "invalid_grant"}
  if (!(await personMayUseWebsite(client, identity.mentraUserId))) return {ok: false, error: "access_denied"}
  try {
    const minted = await mintMiniappTokenFor({
      mentraUserId: identity.mentraUserId,
      tenantId: identity.tenantId,
      packageName: client.website.packageName,
      website: {clientId: client.clientId, ttlSec: WEBSITE_TOKEN_TTL_SEC},
    })
    return {
      ok: true,
      body: {...body, access_token: minted.token, token_type: "Bearer", expires_in: WEBSITE_TOKEN_TTL_SEC},
    }
  } catch (error) {
    if (error instanceof MiniappTokenUnavailableError) return {ok: false, error: "temporarily_unavailable"}
    throw error
  }
}
