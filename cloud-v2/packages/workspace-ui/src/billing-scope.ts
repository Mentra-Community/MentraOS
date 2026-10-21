/**
 * Whose billing a call is about. This module and `billing-errors.ts` carry no schemas, so the query layer and
 * the screens that only need to name an owner or tell a refusal apart don't pull the contract's zod schemas into
 * a host that never reads billing. `billing-api.ts` (the client) is what reaches them.
 */

import type { LicenseScope } from "./strings/licenses";

/** Whose billing: a workspace's, or the signed-in person's own (the personal Billing page). */
export type BillingScope = { kind: "workspace"; workspaceId: string } | { kind: "account" };

/** The signed-in person's own billing. */
export const ACCOUNT_SCOPE: BillingScope = { kind: "account" };

export const workspaceScope = (workspaceId: string): BillingScope => ({ kind: "workspace", workspaceId });

/** The owner type a scope sells to: a workspace's licenses, or a person's own. */
export const ownerTypeOf = (scope: BillingScope): LicenseScope => (scope.kind === "workspace" ? "workspace" : "person");
