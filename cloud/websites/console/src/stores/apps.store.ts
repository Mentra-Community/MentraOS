/**
 * apps.store.ts
 *
 * Zustand store for Console applications.
 * - Global view for the active org (apps/list)
 * - Persistent cache by org: appsByOrgId: Record<orgId, AppResponse[]>
 * - Target endpoints: /api/console/*
 * - Legacy fallback remains during migration for 404 only
 *
 * Notes:
 * - orgs.store sets axios.defaults.headers["x-org-id"] when selected org changes (bridge only)
 * - This store logs key lifecycle events to help diagnose org switching and app refetch issues
 *   (e.g., fetchApps:start/done, cacheHit, get/update/delete, publish, apiKey, move)
 */

import api, { AppResponse } from "@/services/api.service";
import { create } from "zustand";

export type AppState = {
  // Global view for the currently "active" org (used by pages like AppList)
  appsByPackage: Record<string, AppResponse>;
  list: string[]; // ordered packageNames for current view

  // Per-org cache so switching org doesn't require refetch
  appsByOrgId: Record<string, AppResponse[]>;
  lastFetchedAtByOrgId: Record<string, number | null>;

  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
};

export type AppActions = {
  /**
   * Fetch apps for the current org context.
   * - Target: GET /api/console/apps?orgId=<id>
   * - Legacy: GET /api/dev/apps (x-org-id header)
   *
   * Logs:
   * - "[apps.store] fetchApps:start" with orgId
   * - "[apps.store] fetchApps:done" with count
   * - "[apps.store] fetchApps:error" with message
   */
  fetchApps: (params?: { orgId?: string }) => Promise<void>;

  /**
   * Fetch a single app by package name.
   * - Target: GET /api/console/apps/:packageName
   * - Legacy: GET /api/dev/apps/:packageName
   */
  getApp: (packageName: string) => Promise<AppResponse | null>;

  /**
   * Create a new app.
   * - Target: POST /api/console/apps (body may include orgId)
   * - Legacy: POST /api/dev/apps/register (x-org-id header)
   * Returns: { app, apiKey? }
   */
  createApp: (
    data: Partial<AppResponse> & { packageName: string },
    orgId: string,
  ) => Promise<{ app: AppResponse; apiKey?: string }>;

  /**
   * Update an existing app by package name.
   * - Target: PUT /api/console/apps/:packageName
   * - Legacy: PUT /api/dev/apps/:packageName
   */
  updateApp: (
    packageName: string,
    data: Partial<AppResponse>,
  ) => Promise<AppResponse>;

  /**
   * Delete an app by package name.
   * - Target: DELETE /api/console/app/:packageName
   * - Legacy: DELETE /api/dev/apps/:packageName
   */
  deleteApp: (packageName: string) => Promise<void>;

  /**
   * Publish an app by package name.
   * - Target: POST /api/console/apps/:packageName/publish
   * - Legacy: POST /api/dev/apps/:packageName/publish
   */
  publishApp: (packageName: string) => Promise<AppResponse>;

  /**
   * Regenerate API key for app by package name.
   * - Target: POST /api/console/apps/:packageName/api-key
   * - Legacy: POST /api/dev/apps/:packageName/api-key
   * Returns: { apiKey, createdAt? }
   */
  regenerateApiKey: (
    packageName: string,
  ) => Promise<{ apiKey: string; createdAt?: string }>;

  /**
   * Move an app to a different organization.
   * - Target: POST /api/console/apps/:packageName/move { targetOrgId }
   * - Legacy: POST /api/dev/apps/:packageName/move-org { targetOrgId } (x-org-id header = source)
   */
  moveApp: (packageName: string, targetOrgId: string) => Promise<AppResponse>;

  clearError: () => void;
};

export type AppStore = AppState & AppActions;

function mergeApps(state: AppState, apps: AppResponse[]): AppState {
  const next = { ...state.appsByPackage };
  const order: string[] = [];
  for (const app of apps) {
    next[app.packageName] = { ...(next[app.packageName] || {}), ...app };
    order.push(app.packageName);
  }
  return {
    ...state,
    appsByPackage: next,
    list: order,
    lastFetchedAt: Date.now(),
  };
}

export const useAppStore = create<AppStore>((set, get) => ({
  // State
  appsByPackage: {},
  list: [],
  appsByOrgId: {},
  lastFetchedAtByOrgId: {},
  loading: false,
  error: null,
  lastFetchedAt: null,

  // Actions
  fetchApps: async (params) => {
    const orgId = params?.orgId;
    // Debug log
    console.log("[apps.store] fetchApps:start", { orgId });

    // If orgId provided and we have a cached partition, just swap the global view
    if (
      orgId &&
      get().appsByOrgId[orgId] &&
      get().appsByOrgId[orgId].length > 0
    ) {
      const cached = get().appsByOrgId[orgId];

      console.log("[apps.store] fetchApps:cacheHit", {
        orgId,
        count: cached.length,
      });
      const appsByPackage = cached.reduce<Record<string, AppResponse>>(
        (acc, a) => {
          acc[a.packageName] = a;
          return acc;
        },
        {},
      );
      set({
        appsByPackage,
        list: cached.map((a) => a.packageName),
        loading: false,
        error: null,
        lastFetchedAt: get().lastFetchedAtByOrgId[orgId] ?? Date.now(),
      });
      return;
    }

    set({ loading: true, error: null });
    try {
      const data = await api.console.apps.getAll(orgId);
      const apps = data;
      // Debug log
      console.log("[apps.store] fetchApps:done", { count: apps.length, orgId });

      // Write into per-org cache if orgId provided
      if (orgId) {
        set((s) => ({
          appsByOrgId: {
            ...s.appsByOrgId,
            [orgId]: apps,
          },
          lastFetchedAtByOrgId: {
            ...s.lastFetchedAtByOrgId,
            [orgId]: Date.now(),
          },
        }));
      }

      // Always update the global view to reflect the active org (if provided),
      // otherwise merge into the current view for backwards compatibility.
      if (orgId) {
        const appsByPackage = apps.reduce<Record<string, AppResponse>>(
          (acc, a) => {
            acc[a.packageName] = a;
            return acc;
          },
          {},
        );
        set({
          appsByPackage,
          list: apps.map((a) => a.packageName),
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
      } else {
        set((s) => ({ ...mergeApps(s, apps), loading: false, error: null }));
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch apps";
      // Debug log
      console.log("[apps.store] fetchApps:error", { message, orgId });
      set({ loading: false, error: message });
    }
  },

  getApp: async (packageName) => {
    set({ loading: true, error: null });
    try {
      const data = await api.console.apps.getByPackageName(packageName);
      const app: AppResponse = data;
      if (app.packageName) {
        set((s) => ({
          loading: false,
          error: null,
          appsByPackage: {
            ...s.appsByPackage,
            [app.packageName]: {
              ...(s.appsByPackage[app.packageName] || {}),
              ...app,
            },
          },
          list: s.list.includes(app.packageName)
            ? s.list
            : [...s.list, app.packageName],
        }));
      } else {
        set({ loading: false });
      }
      return app.packageName ? app : null;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch app";
      set({ loading: false, error: message });
      return null;
    }
  },

  createApp: async (data, orgId) => {
    set({ loading: true, error: null });
    try {
      const { app: rawApp, apiKey } = await api.console.apps.register(
        orgId ? { ...data, orgId } : data,
      );
      const app: AppResponse = rawApp;

      if (app.packageName) {
        set((s) => ({
          loading: false,
          error: null,
          appsByPackage: {
            ...s.appsByPackage,
            [app.packageName]: {
              ...(s.appsByPackage[app.packageName] || {}),
              ...app,
            },
          },
          list: s.list.includes(app.packageName)
            ? s.list
            : [app.packageName, ...s.list],
        }));
      } else {
        set({ loading: false });
      }

      return { app, apiKey };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to create app";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  updateApp: async (packageName, data) => {
    set({ loading: true, error: null });
    try {
      const updated = await api.console.apps.update(packageName, data);
      const app: AppResponse = updated;
      if (app.packageName) {
        set((s) => ({
          loading: false,
          error: null,
          appsByPackage: {
            ...s.appsByPackage,
            [app.packageName]: {
              ...(s.appsByPackage[app.packageName] || {}),
              ...app,
            },
          },
          list: s.list.includes(app.packageName)
            ? s.list
            : [...s.list, app.packageName],
        }));
      } else {
        set({ loading: false });
      }

      return app;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update app";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  deleteApp: async (packageName) => {
    set({ loading: true, error: null });
    try {
      await api.console.apps.delete(packageName);

      set((s) => {
        const next = { ...s.appsByPackage };
        delete next[packageName];
        return {
          loading: false,
          error: null,
          appsByPackage: next,
          list: s.list.filter((p) => p !== packageName),
        };
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to delete app";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  publishApp: async (packageName) => {
    set({ loading: true, error: null });
    try {
      const published = await api.console.apps.publish(packageName);
      const app: AppResponse = published;
      if (app.packageName) {
        set((s) => ({
          loading: false,
          error: null,
          appsByPackage: {
            ...s.appsByPackage,
            [app.packageName]: {
              ...(s.appsByPackage[app.packageName] || {}),
              ...app,
            },
          },
          list: s.list.includes(app.packageName)
            ? s.list
            : [...s.list, app.packageName],
        }));
      } else {
        set({ loading: false });
      }
      return app;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to publish app";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  regenerateApiKey: async (packageName) => {
    set({ loading: true, error: null });
    try {
      const { apiKey, createdAt } =
        await api.console.apps.apiKey.regenerate(packageName);
      set({ loading: false, error: null });
      return { apiKey, createdAt };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to regenerate API key";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  moveApp: async (packageName, targetOrgId) => {
    set({ loading: true, error: null });
    try {
      const moved = await api.console.apps.moveToOrg(packageName, targetOrgId);

      const app: AppResponse = moved;
      if (app.packageName) {
        set((s) => ({
          loading: false,
          error: null,
          appsByPackage: {
            ...s.appsByPackage,
            [app.packageName]: {
              ...(s.appsByPackage[app.packageName] || {}),
              ...app,
            },
          },
          list: s.list.includes(app.packageName)
            ? s.list
            : [...s.list, app.packageName],
        }));
      } else {
        set({ loading: false });
      }
      return app;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to move app";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  clearError: () => set({ error: null }),
}));

/**
 * Usage:
 * const { list, appsByPackage, fetchApps } = useAppStore();
 * await useAppStore.getState().fetchApps(); // relies on global "x-org-id" header set by org.store
 *
 * Notes:
 * - For target routes, you may pass { orgId } to fetchApps() to avoid header reliance:
 *   await useAppStore.getState().fetchApps({ orgId: "..." });
 * - During migration, both patterns are supported.
 */
