/**
 * @fileoverview Ending a person's sessions at their identity provider, as part
 * of an account-wide revocation.
 *
 * For a Mentra account (tenant `mentra`), every Supabase session of the person
 * ends (`signOutAllSessions`), so the sign-in page, the Developer Console and
 * the CLI cannot refresh their way back in. A Private Cloud provider's
 * sessions belong to the customer, so Core does nothing there; Core still
 * refuses that provider's earlier tokens through `webSignInsRevokedAt`.
 *
 * Failures are logged and never block the revocation (or an account
 * deletion); the next revocation tries again.
 */

import {createLogger} from "@mentra/cloud-shared"

import {signOutAllSessions} from "../account/gotrue.client"
import {MENTRA_TENANT_ID} from "./config"

const logger = createLogger("core").child({service: "idp-revocation"})

function supabaseSignOutConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_JWT_SECRET?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  )
}

export async function endIdentityProviderSessions(user: {mentraUserId: string; tenantId: string; tenantUserId: string}): Promise<void> {
  if (user.tenantId !== MENTRA_TENANT_ID || !supabaseSignOutConfigured()) return
  try {
    await signOutAllSessions(user.tenantUserId)
  } catch (err) {
    logger.warn({mentraUserId: user.mentraUserId, errorName: (err as Error)?.name}, "could not end the person's Supabase sessions")
  }
}
