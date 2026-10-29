/**
 * Whose billing a call is about. This module and `billing-errors.ts` carry no schemas, so the query layer and
 * the screens that only need to name an owner or tell a refusal apart don't pull the contract's zod schemas into
 * a host that never reads billing. `billing-api.ts` (the client) is what reaches them.
 */

/** Whose billing: a workspace's. A license belongs to a workspace and to nothing else. */
export type BillingScope = { kind: "workspace"; workspaceId: string };

export const workspaceScope = (workspaceId: string): BillingScope => ({ kind: "workspace", workspaceId });
