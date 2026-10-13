/**
 * @fileoverview Finishing a sign-in at Core's sign-in server.
 *
 * Whoever vouched for the person (Supabase through the sign-in page's
 * hand-off, or the customer's identity provider), the sign-in ends the same
 * way:
 *  - the person's sign-in identity is recorded (`signin_identities`): source,
 *    subject, email and its verification, name. The provider's ID tokens and
 *    Core's view of the person's access tokens read it;
 *  - the hooks registered with `registerAfterSignInHook` run (a throwing hook
 *    is logged and never blocks sign-in);
 *  - the provider interaction is finished with the person as its login.
 *
 * Consent: first-party clients are granted what they asked for without a
 * screen (`grantFirstPartyConsent`); a third-party client's consent comes
 * from the sign-in page's consent screen (`grantConsent`).
 */

import {createLogger} from "@mentra/cloud-shared"
import type Provider from "oidc-provider"

import {SigninIdentityModel} from "../../models/signin-identity.model"
import type {SessionIdentity} from "../signin/browser-session.service"
import {CORE_API_RESOURCE} from "./config"

const logger = createLogger("core").child({service: "oidc-interactions"})

/** The scopes a grant can carry. */
const GRANTABLE_SCOPES = new Set(["openid", "email", "profile"])

export interface SignedInPerson extends SessionIdentity {
  name: string | null
}

export type AfterSignInHook = (identity: SessionIdentity) => Promise<void>
const afterSignInHooks: AfterSignInHook[] = []

/**
 * Run `hook` after every sign-in at Core's sign-in server. A throwing hook is logged and never blocks
 * sign-in. Registering the same hook again changes nothing, so a process that starts Core more than
 * once runs it once per sign-in.
 */
export function registerAfterSignInHook(hook: AfterSignInHook): void {
  if (!afterSignInHooks.includes(hook)) afterSignInHooks.push(hook)
}

/** Record the person's sign-in identity and run the after-sign-in hooks. */
export async function recordSignIn(person: SignedInPerson): Promise<void> {
  await SigninIdentityModel.updateOne(
    {mentraUserId: person.mentraUserId},
    {
      $set: {
        tenantId: person.tenantId,
        sourceId: person.sourceId,
        subject: person.subject,
        email: person.email,
        emailVerified: person.emailVerified,
        name: person.name,
        signedInAt: person.authTime,
      },
    },
    {upsert: true},
  )
  const {name: _name, ...identity} = person
  for (const hook of afterSignInHooks) {
    try {
      await hook(identity)
    } catch (err) {
      logger.error({errorName: (err as Error)?.name}, "after-sign-in hook failed")
    }
  }
}

/** The scopes of an authorization request that a grant can carry. */
export function grantableScopes(requested: unknown): string {
  return String(requested ?? "")
    .split(" ")
    .filter(scope => GRANTABLE_SCOPES.has(scope))
    .join(" ")
}

/** Create a grant for `scope` and return its ID. */
export async function saveGrant(provider: Provider, accountId: string, clientId: string, scope: string): Promise<string> {
  const grant = new provider.Grant({accountId, clientId})
  if (scope) {
    grant.addOIDCScope(scope)
    grant.addResourceScope(CORE_API_RESOURCE, scope)
  }
  return grant.save()
}
