/**
 * org.store.ts
 *
 * Placeholder Zustand store for Console organizations.
 * - Manages organizations list and the selected organization.
 * - Synchronizes global header "x-org-id" for legacy routes (temporary bridge).
 * - Persists selectedOrgId locally to survive reloads.
 *
 * Notes:
 * - The Cloud backend is responsible for ensuring a default org exists at auth
 *   and/or on org-required actions. The UI does NOT auto-create orgs by policy.
 * - Prefer the target endpoints under /api/console/orgs once available.
 *   Keep a legacy fallback (/api/orgs) until migration completes.
 * - When the selected org changes, we set axios.defaults.headers["x-org-id"]
 *   to avoid breaking existing /api/dev/* routes during migration.
 *
 * Debug logging:
 * - This store logs important lifecycle events (bootstrap, loadOrgs, selection changes)
 *   to help diagnose issues where the app list does not refresh on org switch.
 */

import api, { Organization } from "@/services/api.service";
import axios from "axios";
import { create } from "zustand";

const PERSIST_KEY = "console:selectedOrgId";

export type OrgState = {
  orgs: Organization[];
  selectedOrgId: string | null;
  loading: boolean;
  error: string | null;
  _debugLog: (...args: unknown[]) => void;
};

export type OrgActions = {
  /**
   * Initialize org state:
   * - Fetch orgs from the backend.
   * - Restore persisted selectedOrgId and validate it; fallback to first org.
   * - Synchronize the global "x-org-id" header if selection is available.
   */
  bootstrap: () => Promise<void>;

  /**
   * Fetch orgs from the backend (target: /api/console/orgs; legacy: /api/orgs).
   */
  loadOrgs: () => Promise<void>;

  /**
   * Change the selected org:
   * - Updates state
   * - Persists to localStorage
   * - Sets axios.defaults.headers["x-org-id"] (temporary bridge)
   */
  setSelectedOrgId: (orgId: string | null) => void;

  /**
   * Create an organization (target: /api/console/orgs; legacy: /api/orgs),
   * append to orgs, and select it.
   */
  createOrg: (name: string) => Promise<void>;

  /**
   * Utility to clear error state.
   */
  clearError: () => void;
};

export type OrgStore = OrgState & OrgActions;

function setGlobalOrgHeader(orgId: string | null) {
  if (orgId) {
    axios.defaults.headers.common["x-org-id"] = orgId;
  } else {
    delete axios.defaults.headers.common["x-org-id"];
  }
}

function persistSelectedOrgId(orgId: string | null) {
  try {
    if (orgId) {
      window.localStorage.setItem(PERSIST_KEY, orgId);
    } else {
      window.localStorage.removeItem(PERSIST_KEY);
    }
  } catch {
    // ignore storage errors (SSR or privacy mode)
  }
}

function readPersistedSelectedOrgId(): string | null {
  try {
    return window.localStorage.getItem(PERSIST_KEY);
  } catch {
    return null;
  }
}

export const useOrgStore = create<OrgStore>((set, get) => ({
  // Debug helper
  _debugLog: (...args: unknown[]) => console.log("[orgs.store]", ...args),
  // State
  orgs: [],
  selectedOrgId: null,
  loading: false,
  error: null,

  // Actions
  bootstrap: async () => {
    get()._debugLog("bootstrap:start");
    set({ loading: true, error: null });
    try {
      await get().loadOrgs();

      const state = get();
      const persisted = readPersistedSelectedOrgId();
      get()._debugLog("bootstrap:loadedOrgs", {
        count: state.orgs.length,
        persisted,
      });

      let selected: string | null = null;
      if (persisted && state.orgs.some((o) => o.id === persisted)) {
        selected = persisted;
        get()._debugLog("bootstrap:selectingPersisted", selected);
      } else {
        selected = state.orgs.length > 0 ? state.orgs[0].id : null;
        get()._debugLog("bootstrap:selectingDefaultFirst", selected);
      }

      set({ selectedOrgId: selected, loading: false });
      setGlobalOrgHeader(selected);
      persistSelectedOrgId(selected);
      get()._debugLog("bootstrap:done", { selected });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to initialize organizations";
      set({ loading: false, error: message });
      get()._debugLog("bootstrap:error", message);
    }
  },

  loadOrgs: async () => {
    get()._debugLog("loadOrgs:start");
    set({ loading: true, error: null });
    try {
      const orgs = await api.console.orgs.list();

      set({ orgs, loading: false, error: null });
      get()._debugLog("loadOrgs:done", { count: orgs.length });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load organizations";
      set({ loading: false, error: message, orgs: [] });
      get()._debugLog("loadOrgs:error", message);
      // Do not clear selected header here; selection may still be valid for legacy calls
    }
  },

  setSelectedOrgId: (orgId: string | null) => {
    const prev = get().selectedOrgId;
    set({ selectedOrgId: orgId });
    setGlobalOrgHeader(orgId);
    persistSelectedOrgId(orgId);
    get()._debugLog("setSelectedOrgId", { prev, next: orgId });
  },

  createOrg: async (name: string) => {
    set({ loading: true, error: null });
    try {
      const newOrg = await api.console.orgs.create(name);

      const orgs = [...get().orgs, newOrg];
      set({ orgs, selectedOrgId: newOrg.id, loading: false, error: null });
      setGlobalOrgHeader(newOrg.id);
      persistSelectedOrgId(newOrg.id);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create organization";
      set({ loading: false, error: message });
    }
  },

  clearError: () => set({ error: null }),
}));

/**
 * Usage examples:
 *
 * const { orgs, selectedOrgId, loading } = useOrgStore();
 * const bootstrap = useOrgStore(s => s.bootstrap);
 * const setSelectedOrgId = useOrgStore(s => s.setSelectedOrgId);
 *
 * // App init:
 * await useOrgStore.getState().bootstrap();
 *
 * // Change org:
 * useOrgStore.getState().setSelectedOrgId(newOrgId);
 *
 * // Create org:
 * await useOrgStore.getState().createOrg("Personal Org");
 */
