import { proxyToCore, type ProxyContext } from "../_upstream";

export async function onRequest(context: ProxyContext): Promise<Response> {
  return proxyToCore(context);
}
