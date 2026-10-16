import type { InteractionApi } from "./interaction-api";
import { readInteractionId } from "./links";

/**
 * The consent route (`/consent?interaction=…`). First-party clients never
 * reach it: Core grants them without a screen. A third-party client, a
 * miniapp website, shows what it asks for, and the person allows or denies.
 */
export interface ConsentDetails {
  clientName: string;
  scopes: string[];
}

export type ConsentState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "consent"; interactionId: string; consent: ConsentDetails }
  | { kind: "redirecting" }
  | { kind: "error" };

export type ConsentDecision = "allow" | "deny";

export interface ConsentDeps {
  api: InteractionApi;
  /** Navigates the page away. Only ever called with the provider's continuation. */
  navigate: (url: string) => void;
}

export function initialConsentState(search: string): ConsentState {
  return readInteractionId(search) ? { kind: "loading" } : { kind: "invalid" };
}

export async function startConsent(deps: ConsentDeps, search: string): Promise<ConsentState> {
  const interactionId = readInteractionId(search);
  if (!interactionId) return { kind: "invalid" };
  const details = await deps.api.details(interactionId);
  if (details.kind === "expired") return { kind: "expired" };
  if (details.kind === "error" || details.prompt !== "consent") return { kind: "error" };
  return { kind: "consent", interactionId, consent: { clientName: details.clientName || "This app", scopes: details.scopes } };
}

export async function decideConsent(deps: ConsentDeps, interactionId: string, decision: ConsentDecision): Promise<ConsentState> {
  const result = await deps.api.decide(interactionId, decision);
  if (result.kind === "continue") {
    deps.navigate(result.url);
    return { kind: "redirecting" };
  }
  return result.kind === "expired" ? { kind: "expired" } : { kind: "error" };
}
