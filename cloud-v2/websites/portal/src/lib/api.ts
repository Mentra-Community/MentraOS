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
  email: string | null;
  emailVerified: boolean;
};

/**
 * Which portal modules this Core offers. The same for everyone who signs in to it.
 *
 * - `billing`: billing is installed and ready. Its catalog can be read, so the Licenses page and the Members list
 *   can name licenses, and whoever manages a workspace's billing (`workspace.billing.manage`) sees money, buys and
 *   manages there. A Private Cloud with no billing says false.
 */
export type PortalModules = {
  billing: boolean;
};

/** `GET /api/portal/me`. */
export type PortalMe = {
  authenticated: true;
  user: PortalUser;
  workspaceCreation: WorkspaceCreation;
  onboardingRequired: boolean;
  org: EnterpriseOrg | null;
  modules: PortalModules;
};

/**
 * The modules as `/api/portal/me` sent them, read strictly: only an explicit `true` offers one, and a Core that
 * sends no `modules` (the portal and Core deploy separately) offers none, rather than failing the page.
 */
export function readPortalModules(raw: unknown): PortalModules {
  const modules = typeof raw === "object" && raw !== null ? (raw as { billing?: unknown }) : {};
  return { billing: modules.billing === true };
}

/** `GET /api/portal/me`, with the modules read by {@link readPortalModules}. */
export async function fetchPortalMe(): Promise<PortalMe> {
  const me = await api<Omit<PortalMe, "modules"> & { modules?: unknown }>("/api/portal/me");
  return { ...me, modules: readPortalModules(me.modules) };
}

/**
 * The name of a product, for a page that has no session yet (the sign-in gate of a `?buy=` link):
 * `GET /api/portal/billing/public/products/<product>`, which needs no sign-in and answers `{name}`, or 404 for a product
 * it doesn't know. Null for anything else: a 404, any other status, a body that isn't `{name: string}`, a dropped
 * connection. The caller says something generic then, and never fails.
 */
export async function fetchPublicProductName(product: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`/api/portal/billing/public/products/${encodeURIComponent(product)}`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { name?: unknown } | null;
    return typeof body?.name === "string" && body.name.trim() !== "" ? body.name.trim() : null;
  } catch {
    return null;
  }
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
