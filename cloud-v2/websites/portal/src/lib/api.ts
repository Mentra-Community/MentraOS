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
 * Which portal modules this person is offered: the module is installed and usable on this Core, and visible
 * to them (billing is staff-only on a Core that is not prod). A Private Cloud with no billing says false.
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
 * `GET /api/portal/me`, with the modules read strictly: only an explicit `true` offers one. A Core that
 * does not send `modules` yet (the portal and Core deploy separately) offers none, rather than failing the page.
 */
export async function fetchPortalMe(): Promise<PortalMe> {
  const me = await api<Omit<PortalMe, "modules"> & { modules?: { billing?: unknown } | null }>("/api/portal/me");
  return { ...me, modules: { billing: me.modules?.billing === true } };
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
