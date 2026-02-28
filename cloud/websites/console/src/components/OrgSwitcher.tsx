import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Building, CheckIcon, ChevronDown } from "lucide-react";
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

  return (
    <div className="px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            <div className="flex items-center gap-2 truncate">
              <Building className="h-4 w-4" />
              <span className="truncate">
                {orgs.find((o) => o.id === selectedOrgId)?.name ||
                  "Select Organization"}
              </span>
            </div>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={4}
          className="w-56"
        >
          <DropdownMenuGroup>
            {orgs.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onClick={async () => {
                  setSelectedOrgId(org.id);
                  const match = location.pathname.match(
                    /^\/apps\/([^/]+)\/edit/,
                  );
                  if (match) {
                    const pkg = decodeURIComponent(match[1]);
                    try {
                      await useAppStore.getState().fetchApps({ orgId: org.id });
                      const exists =
                        !!useAppStore.getState().appsByPackage[pkg];
                      if (!exists) {
                        navigate("/apps");
                      }
                    } catch {
                      navigate("/apps");
                    }
                  }
                }}
                className="flex items-center justify-between"
              >
                <span className="truncate">{org.name}</span>
                {selectedOrgId === org.id && (
                  <CheckIcon className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default OrgSwitcher;
