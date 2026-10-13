import { relayToCore, type RelayContext } from "./_upstream";

/** Relays the provider's routes to this environment's Core; serves the sign-in page otherwise. */
export async function onRequest(context: RelayContext): Promise<Response> {
  return relayToCore(context);
}
