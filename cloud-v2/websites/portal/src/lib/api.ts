/** JSON calls to the portal's own `/api/portal/*` routes (the workspace screens use `@mentra/workspace-ui`'s client). */

import type { WorkspaceCreation } from "./portal";

export type EnterpriseOrg = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: "active" | "disabled" | "pending";
};

export type PortalUser = {
  /** The Core user ID. */
  id: string;
  /** The same ID under the Fleet UI contract's name. */
  mentraUserId?: string;
  email: string | null;
  emailVerified: boolean;
};

/**
 * What this person is offered of billing. They are separate because they are not the same people: on a Core that
 * is not prod billing is staff-only, but its catalog (the products' names and icons, which name the licenses a
 * workspace holds) is readable by every Admin.
 *
 * - `billing`: billing is ready and visible to them. They see money, buy, and manage: the Billing page, the
 *   Licenses page's totals and actions. A Private Cloud with no billing says false.
 * - `billingCatalog`: billing is ready, whoever asks. Licenses can be named, so the Licenses page and the
 *   Members list can draw them. True wherever `billing` is.
 */
export type PortalModules = {
  billing: boolean;
  billingCatalog: boolean;
};

/** `GET /api/portal/me`. */
export type PortalMe = {
  authenticated: true;
  user: PortalUser;
  workspaceCreation: WorkspaceCreation;
  onboardingRequired: boolean;
  org: EnterpriseOrg | null;
  modules: PortalModules;
  /** The organization capabilities Fleet's UI reads (absent from a Core that predates Fleet in the portal). */
  organization?: { capabilities: string[] };
  /**
   * The workspaces the person may use Fleet in, with their capabilities there. At most one; for an Organization
   * Admin it is exactly the workspace the request named with `?workspaceId=`, member or not.
   */
  workspaces?: Array<{ workspaceId: string; name: string; capabilities: string[] }>;
  fleet?: { installed: boolean };
};

/**
 * The modules as `/api/portal/me` sent them, read strictly: only an explicit `true` offers one, and a Core that
 * sends no `modules` (the portal and Core deploy separately) offers none, rather than failing the page. Billing
 * implies its catalog (decision 4: the catalog is readable wherever billing is ready, whoever asks), so
 * `billingCatalog` is true where `billing` is, whatever it says itself. That also reads a Core from before
 * `billingCatalog` existed, which sent only `billing`. A `billingCatalog` that is there but isn't true offers nothing of its own.
 */
export function readPortalModules(raw: unknown): PortalModules {
  const modules = typeof raw === "object" && raw !== null ? (raw as { billing?: unknown; billingCatalog?: unknown }) : {};
  const billing = modules.billing === true;
  return { billing, billingCatalog: billing || modules.billingCatalog === true };
}

/**
 * `GET /api/portal/me`, with the modules read by {@link readPortalModules}. `workspaceId` asks Core for that
 * workspace's Fleet capabilities as well.
 */
export async function fetchPortalMe(workspaceId?: string): Promise<PortalMe> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const me = await api<Omit<PortalMe, "modules"> & { modules?: unknown }>(`/api/portal/me${query}`);
  return { ...me, modules: readPortalModules(me.modules) };
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error_description?: string; error?: string };
      message = body.error_description || body.error || message;
    } catch {
      // Keep generic status text.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** This browser's localStorage, or null where it is unavailable (private mode, a server render). */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
