import {coreUpstream, proxyTo, type ProxyContext} from "../../../_upstream"

/**
 * Incident triage and support profiles are Core features on Core's database,
 * so they go straight to Core. Routing them through the Store would mean a
 * Store outage also took out the tool you need during an outage.
 */
export async function onRequest(context: ProxyContext): Promise<Response> {
  return proxyTo(context, coreUpstream(context.env), "CORE_URL")
}
