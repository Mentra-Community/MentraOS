import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@mentra/shared";
import { Building } from "lucide-react";
import { useOrgStore } from "@/stores/orgs.store";
import { useNavigate, useLocation } from "react-router-dom";
import { useAppStore } from "@/stores/apps.store";

/**
 * Organization switcher dropdown for the sidebar header
 * Allows users to switch between organizations and create new ones
 */
export function OrgSwitcher() {
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const setSelectedOrgId = useOrgStore((s) => s.setSelectedOrgId);
  const loading = useOrgStore((s) => s.loading);
  const navigate = useNavigate();
  const location = useLocation();

  const isInitialLoading = loading && orgs.length === 0;

  // If there's only one organization (personal), don't show the switcher
  // But show it during re-authentication if we already have the data
  if (orgs.length <= 1 || isInitialLoading) {
    return null;
  }

  const handleOrgChange = async (orgId: string) => {
    setSelectedOrgId(orgId);
    const match = location.pathname.match(/^\/apps\/([^/]+)\/edit/);
    if (match) {
      const pkg = decodeURIComponent(match[1]);
      try {
        await useAppStore.getState().fetchApps({ orgId });
        const exists = !!useAppStore.getState().appsByPackage[pkg];
        if (!exists) {
          navigate("/apps");
        }
      } catch {
        navigate("/apps");
      }
    }
  };

  return (
    <div className="px-3 py-2">
      <Select value={selectedOrgId || ""} onValueChange={handleOrgChange}>
        <SelectTrigger className="w-full">
          <div className="flex items-center gap-2 truncate">
            <Building className="h-4 w-4" />
            <SelectValue placeholder="Select Organization" />
          </div>
        </SelectTrigger>
        <SelectContent>
          {orgs.map((org) => (
            <SelectItem key={org.id} value={org.id}>
              {org.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default OrgSwitcher;
