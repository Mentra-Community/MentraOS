import React, { createContext, useContext, useEffect, useState } from 'react';
import api, { Organization } from '../services/api.service';
import { useAuth } from '@mentra/shared'
import { toast } from 'sonner';

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
const CURRENT_ORG_STORAGE_KEY = 'mentraos_current_org';

/**
 * Provider component that wraps the app and makes organization data available
 */
export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  // State for storing organizations and current selection
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Use isLoading from Auth context; alias to authLoading for clarity
  const { user, isLoading: authLoading, refreshUser, tokenReady } = useAuth();

  /**
   * Creates a personal organization for the user if none exists
   * @returns Promise that resolves when the personal organization is created
   */
  const ensurePersonalOrg = async (): Promise<void> => {
    if (!user || !user.email) return;

    try {
      setLoading(true);

      // First check if the user already has any organizations
      const organizations = await api.orgs.list();

      if (organizations.length > 0) {
        // User already has at least one organization
        setOrgs(organizations);

        // Set the first org as current if none selected
        if (!currentOrg) {
          setCurrentOrgState(organizations[0]);
          localStorage.setItem(CURRENT_ORG_STORAGE_KEY, organizations[0].id);
        }

        setLoading(false);
        return;
      }

      // Only create a new organization if the user has none
      const emailLocalPart = user.email.split('@')[0] || 'User';
      const personalOrgName = `${emailLocalPart}'s Organization`;
      const newOrg = await api.orgs.create(personalOrgName);

      // Update the organizations list
      setOrgs([newOrg]);

      // Set as current organization
      setCurrentOrgState(newOrg);
      localStorage.setItem(CURRENT_ORG_STORAGE_KEY, newOrg.id);

      // Refresh user to update organizations in user data
      if (refreshUser) {
        await refreshUser();
      }
    } catch (err) {
      console.error('Error creating personal organization:', err);
      setError(err instanceof Error ? err : new Error('Failed to create personal organization'));
      toast.error('Failed to create organization');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Loads the list of organizations from the API
   */
  const loadOrganizations = async () => {
    if (!user) return;

    try {
      setLoading(true);
      setError(null);

      // Fetch organizations from API
      const organizations = await api.orgs.list();
      setOrgs(organizations);

      // If user has no organizations, create a personal one
      if (organizations.length === 0) {
        await ensurePersonalOrg();
        return; // ensurePersonalOrg already handles setting currentOrg
      }

      // Restore current org from localStorage or set to first available
      const storedOrgId = localStorage.getItem(CURRENT_ORG_STORAGE_KEY);

      if (storedOrgId && organizations.length > 0) {
        const storedOrg = organizations.find(org => org.id === storedOrgId);
        if (storedOrg) {
          setCurrentOrgState(storedOrg);
        } else {
          // If stored org is not in the list, use the first one
          setCurrentOrgState(organizations[0]);
          localStorage.setItem(CURRENT_ORG_STORAGE_KEY, organizations[0].id);
        }
      } else if (organizations.length > 0) {
        // No stored org or empty list, use the first one
        setCurrentOrgState(organizations[0]);
        localStorage.setItem(CURRENT_ORG_STORAGE_KEY, organizations[0].id);
      }

      // (Removed) refreshUser() call here caused a feedback loop because it
      // sets a new `user` object on every call, which retriggers this
      // effect. Organization data is already available, and AuthProvider
      // will refresh user info periodically, so this extra call is not
      // necessary and leads to infinite re-renders.
    } catch (err) {
      console.error('Error loading organizations:', err);
      setError(err instanceof Error ? err : new Error('Failed to load organizations'));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Updates the current organization and persists to localStorage
   */
  const setCurrentOrg = (org: Organization) => {
    setCurrentOrgState(org);
    localStorage.setItem(CURRENT_ORG_STORAGE_KEY, org.id);
  };

  /**
   * Refreshes the list of organizations
   */
  const refreshOrgs = async () => {
    await loadOrganizations();
  };

  // Load organizations when the user changes or auth loading completes
  useEffect(() => {
    if (!authLoading && tokenReady && user) {
      loadOrganizations();
    }
  }, [user?.id, authLoading, tokenReady]);

  // Context value that will be provided to consumers
  const contextValue: OrganizationContextType = {
    orgs,
    currentOrg,
    setCurrentOrg,
    refreshOrgs,
    loading,
    error,
    ensurePersonalOrg
  };

  return (
    <OrganizationContext.Provider value={contextValue}>
      {children}
    </OrganizationContext.Provider>
  );
}

/**
 * Hook that provides access to the organization context
 * @returns Organization context values
 * @throws Error if used outside of OrganizationProvider
 */
export function useOrganization() {
  const context = useContext(OrganizationContext);

  if (context === undefined) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }

  return context;
}