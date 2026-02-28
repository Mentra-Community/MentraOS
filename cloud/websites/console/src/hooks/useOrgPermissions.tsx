import { useEffect, useState } from "react";
import { useAuth } from "@mentra/shared";
import { useOrganization } from "../context/OrganizationContext";
import { OrgRole } from "@/services/api.service";
import api from "@/services/api.service";

/**
 * Interface for organization permissions
 */
interface OrgPermissions {
  /** Whether user has admin privileges */
  isAdmin: boolean;
  /** Current user's role in the organization */
  currentRole: OrgRole | null;
  /** Whether permissions have been loaded */
  loading: boolean;
}

/**
 * Hook to check user's permissions within the current organization
 * @returns Organization permissions for the current user
 */
export function useOrgPermissions(): OrgPermissions {
  const { user } = useAuth();
  const { currentOrg } = useOrganization();
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [currentRole, setCurrentRole] = useState<OrgRole | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const determinePermissions = async () => {
      setLoading(true);
      setIsAdmin(false);
      setCurrentRole(null);

      if (!currentOrg || !user) {
        setLoading(false);
        return;
      }

      try {
        // Fetch the full org details to ensure we have populated members data
        const orgDetails = await api.orgs.get(currentOrg.id);

        // Find the member entry that matches the current user's email (case-insensitive)
        const emailLower = user.email?.toLowerCase();
        const memberEntry = orgDetails.members?.find(
          (m) => m.user.email?.toLowerCase() === emailLower,
        );

        if (memberEntry) {
          setCurrentRole(memberEntry.role);
          setIsAdmin(memberEntry.role === "admin");
        }
      } catch (error) {
        console.error("Failed to determine org permissions:", error);
      } finally {
        setLoading(false);
      }
    };

    determinePermissions();
    // Only run when org or user changes
  }, [currentOrg?.id, user?.email]);

  return { isAdmin, currentRole, loading };
}
