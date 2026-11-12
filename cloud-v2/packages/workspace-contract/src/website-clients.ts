/**
 * A developer's own miniapp websites: the websites they registered to sign people in with Mentra for a miniapp
 * on their own domain. The Developer Console lists and changes them through the Store, which relays to Core's
 * signed service API (`/api/internal/website-clients`); Core decides everything.
 */

export const WEBSITE_CLIENT_TYPES = ["server", "browser"] as const
export type WebsiteClientType = (typeof WEBSITE_CLIENT_TYPES)[number]

export const WEBSITE_CLIENT_ENVIRONMENTS = ["production", "development"] as const
export type WebsiteClientEnvironment = (typeof WEBSITE_CLIENT_ENVIRONMENTS)[number]

/** A registered website as Core lists it: never its secret. */
export interface WebsiteClientView {
  clientId: string
  /** The miniapp's name, as Core read it from its `miniapp.json`: what the consent screen shows. */
  name: string
  type: WebsiteClientType
  environment: WebsiteClientEnvironment
  redirectUris: string[]
  packageName: string
  /** The developer who registered it; null for one an Organization Admin registered. */
  ownerUserId: string | null
  access: "public" | "private"
  accessWorkspaceIds: string[]
  status: "active" | "disabled"
  /** The last four characters of a server-type website's secret; null for a browser-type one. */
  secretLast4: string | null
  createdAt: string
  updatedAt: string
}

/** What a developer gives to register a website. Its name is not theirs to give. */
export interface WebsiteClientRegistration {
  packageName: string
  type: WebsiteClientType
  environment: WebsiteClientEnvironment
  redirectUris: string[]
}

export interface WebsiteClientChanges {
  redirectUris?: string[]
  status?: "active" | "disabled"
}

/** The routes of Core's service API for a developer's own websites, with what each takes beside `token`. */
export type WebsiteClientsCall =
  | {route: "list"}
  | {route: "create"; client: WebsiteClientRegistration}
  | {route: "update"; clientId: string; changes: WebsiteClientChanges}
  | {route: "regenerate-secret"; clientId: string}
  | {route: "delete"; clientId: string}

/**
 * Core's answer to one of those calls, as it gave it: the result (2xx), or a refusal the person can act on
 * (`{error, error_description, reason?}` with 400, 401, 403, 404 or 422). The caller relays it.
 */
export interface WebsiteClientsAnswer {
  status: number
  body: Record<string, unknown>
}

/** The refusals Core answers a registration with, beside `invalid_request`, `not_found` and `forbidden`. */
export const WEBSITE_CLIENT_REFUSALS = ["not_in_registry", "archived", "domain_mismatch", "too_many_websites"] as const
