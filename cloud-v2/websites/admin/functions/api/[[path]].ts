import {proxyTo, storeUpstream, type ProxyContext} from "../_upstream"

/**
 * Everything else under /api is the Miniapp Store's admin surface (review,
 * submissions, moderation, audit log). More specific routes under
 * api/admin/reports and api/admin/support-profiles take precedence and go to
 * Core instead.
 */
export async function onRequest(context: ProxyContext): Promise<Response> {
  return proxyTo(context, storeUpstream(context.env), "STORE_URL")
}
