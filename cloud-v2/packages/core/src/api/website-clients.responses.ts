/**
 * @fileoverview How a refused website-client write is answered, for both surfaces that write them
 * (`admin/website-clients.api.ts`, `internal/website-clients.api.ts`).
 */

import {WebsiteClientError, type WebsiteClientErrorCode} from "../services/oidc/website-clients.service"
import type {AppContext} from "../types/hono.types"

const ANSWERS: Record<WebsiteClientErrorCode, {status: 400 | 404 | 422; error: string}> = {
  invalid: {status: 400, error: "invalid_request"},
  no_secret: {status: 400, error: "invalid_request"},
  not_found: {status: 404, error: "not_found"},
  not_in_registry: {status: 422, error: "not_in_registry"},
  archived: {status: 422, error: "archived"},
  domain_mismatch: {status: 422, error: "domain_mismatch"},
  too_many_websites: {status: 422, error: "too_many_websites"},
}

/** Run `write`; a `WebsiteClientError` becomes its response, anything else is thrown on. */
export async function answeringRefusals(c: AppContext, write: () => Promise<Response>): Promise<Response> {
  try {
    return await write()
  } catch (error) {
    if (!(error instanceof WebsiteClientError)) throw error
    const answer = ANSWERS[error.code]
    return c.json({error: answer.error, error_description: error.message}, answer.status)
  }
}
