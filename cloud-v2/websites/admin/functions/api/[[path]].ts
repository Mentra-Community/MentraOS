import {proxyTo, coreUpstream, type ProxyContext} from "../_upstream"

export async function onRequest(context: ProxyContext): Promise<Response> {
  return proxyTo(context, coreUpstream(context.env), "CORE_URL")
}
