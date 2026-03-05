import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import api, { Organization } from "../services/api.service";
import { useAuth } from "@mentra/shared";
import { toast } from "sonner";

/**
 * Organization context type definition
 */
interface OrganizationContextType {
  /** List of all organizations the user is a member of */
  orgs: Organization[];
  /** Currently selected organization */
  currentOrg: Organization | null;
  /** Function to set the current organization */
  setCurrentOrg: (org: Organization) => void;
  /** Function to refresh the list of organizations */
  refreshOrgs: () => Promise<void>;
  /** Whether organizations are currently loading */
  loading: boolean;
  /** Any error that occurred while loading organizations */
  error: Error | null;
  /** Ensures the user has at least one organization */
  ensurePersonalOrg: () => Promise<void>;
}

// Create the context with undefined default value
const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

// Local storage key for persisting the current organization
const CURRENT_ORG_STORAGE_KEY = "mentraos_current_org";

/** Small helper — wait `ms` milliseconds (for retry backoff). */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Provider component that wraps the app and makes organization data available.
 */
export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { user, isLoading: authLoading, tokenReady } = useAuth();

  // Ref-based mutex to prevent concurrent ensurePersonalOrg calls.
  // Using a ref instead of state so that concurrent callers see the
  // same value immediately without waiting for a re-render cycle.
  const creatingOrgRef = useRef(false);

  // -----------------------------------------------------------------------
  // Helper: given a list of orgs, update React state + localStorage.
  // -----------------------------------------------------------------------
  const applyOrgs = useCallback(
    (organizations: Organization[]) => {
      setOrgs(organizations);

      if (organizations.length === 0) return;

      // Restore previously-selected org from localStorage, or pick the first.
      const storedOrgId = localStorage.getItem(CURRENT_ORG_STORAGE_KEY);
      const storedOrg = storedOrgId ? organizations.find((o) => o.id === storedOrgId) : null;

      const selected = storedOrg ?? organizations[0];
      setCurrentOrgState(selected);
      localStorage.setItem(CURRENT_ORG_STORAGE_KEY, selected.id);
    },
    [], // no deps — uses only setters (stable) and localStorage
  );

  // -----------------------------------------------------------------------
  // ensurePersonalOrg
  //
  // The frontend does NOT create organisations itself. The backend creates
  // a personal org automatically inside `getConsoleAccount` (triggered by
  // `GET /api/console/account`) and inside the console list endpoint
  // (triggered by `GET /api/console/orgs` → `findOrCreateUser`).
  //
  // This function:
  //   1. Calls `GET /api/console/account` to trigger backend bootstrap.
  //   2. Lists orgs via the console endpoint (which also bootstraps).
  //   3. If still empty, retries the list a few times with backoff to
  //      allow the backend's async org creation to commit.
  // -----------------------------------------------------------------------
  const ensurePersonalOrg = useCallback(async (): Promise<void> => {
    if (!user || !user.email) return;

    // Mutex: if another call is already in-flight, bail out.
    if (creatingOrgRef.current) return;
    creatingOrgRef.current = true;

    try {
      setLoading(true);

      // 1) Trigger the backend bootstrap. getConsoleAccount creates a
      //    personal org if the user has none. We don't need the response
      //    value — we just need the side-effect.
      try {
        await api.console.account.get();
      } catch {
        // Non-fatal — the list endpoint also bootstraps via findOrCreateUser.
      }

      // 2) List via the console endpoint (goes through findOrCreateUser,
      //    which also bootstraps orgs for new users as a side-effect).
      //    Retry a few times with backoff in case the backend's org
      //    creation hasn't committed yet when the list query runs.
      const MAX_RETRIES = 3;
      const BACKOFF_MS = 1000;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const organizations = await api.console.orgs.list();

        if (organizations.length > 0) {
          applyOrgs(organizations);
          return;
        }

        // Not found yet — wait before retrying (skip delay on last attempt).
        if (attempt < MAX_RETRIES) {
          await delay(BACKOFF_MS);
        }
      }

      // All retries exhausted — surface the error.
      setError(new Error("No organizations found after retries"));
      toast.error("Failed to load organizations. Please try refreshing the page.");
    } catch (err) {
      console.error("Error ensuring personal organization:", err);
      setError(err instanceof Error ? err : new Error("Failed to ensure personal organization"));
      toast.error("Failed to create organization");
    } finally {
      setLoading(false);
      creatingOrgRef.current = false;
    }
  }, [user?.email, user?.id, applyOrgs]);

  // -----------------------------------------------------------------------
  // loadOrganizations
  //
  // Uses the console list endpoint (`GET /api/console/orgs`) which goes
  // through `getOrCreateUserByEmail` → `findOrCreateUser`, so it also
  // bootstraps a personal org for new users as a side-effect. If the list
  // still comes back empty (bootstrap in flight), falls through to
  // `ensurePersonalOrg` which retries with backoff.
  // -----------------------------------------------------------------------
  const loadOrganizations = useCallback(async () => {
    if (!user) return;

    try {
      setLoading(true);
      setError(null);

      const organizations = await api.console.orgs.list();
      setOrgs(organizations);

      if (organizations.length === 0) {
        // Backend hasn't finished bootstrapping yet, or this is a brand-new
        // user. `ensurePersonalOrg` will trigger the account endpoint and
        // retry the list with backoff.
        await ensurePersonalOrg();
        return; // ensurePersonalOrg already sets state
      }

      applyOrgs(organizations);
    } catch (err) {
      console.error("Error loading organizations:", err);
      setError(err instanceof Error ? err : new Error("Failed to load organizations"));
    } finally {
      setLoading(false);
    }
  }, [user?.id, ensurePersonalOrg, applyOrgs]);

  /**
   * Updates the current organization and persists to localStorage.
   */
  const setCurrentOrg = useCallback((org: Organization) => {
    setCurrentOrgState(org);
    localStorage.setItem(CURRENT_ORG_STORAGE_KEY, org.id);
  }, []);

  /**
   * Refreshes the list of organizations.
   */
  const refreshOrgs = useCallback(async () => {
    await loadOrganizations();
  }, [loadOrganizations]);

  // Load organizations when the user changes or auth loading completes.
  useEffect(() => {
    if (!authLoading && tokenReady && user) {
      loadOrganizations();
    }
    // loadOrganizations intentionally excluded to avoid re-triggering
    // on every callback recreation. The effect should only fire when
    // auth state changes.
  }, [user?.id, authLoading, tokenReady]);  

  const contextValue: OrganizationContextType = {
    orgs,
    currentOrg,
    setCurrentOrg,
    refreshOrgs,
    loading,
    error,
    ensurePersonalOrg,
  };

  return <OrganizationContext.Provider value={contextValue}>{children}</OrganizationContext.Provider>;
}

/**
 * Hook that provides access to the organization context.
 * @returns Organization context values
 * @throws Error if used outside of OrganizationProvider
 */
export function useOrganization() {
  const context = useContext(OrganizationContext);

  if (context === undefined) {
    throw new Error("useOrganization must be used within an OrganizationProvider");
  }

  return context;
}
