import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuGroup
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Building, CheckIcon, Plus, ChevronDown } from "lucide-react";
import { useOrganization } from "@/context/OrganizationContext";
import { useNavigate } from 'react-router-dom';

/**
 * Organization switcher dropdown for the sidebar header
 * Allows users to switch between organizations and create new ones
 */
export function OrgSwitcher() {
  const { orgs, currentOrg, setCurrentOrg, loading } = useOrganization();
  const navigate = useNavigate();

  // If there's only one organization (personal), don't show the switcher
  if (orgs.length <= 1 || loading) {
    return null;
  }

  return (
    <div className="px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            <div className="flex items-center gap-2 truncate">
              <Building className="h-4 w-4" />
              <span className="truncate">{currentOrg?.name || 'Select Organization'}</span>
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
                onClick={() => setCurrentOrg(org)}
                className="flex items-center justify-between"
              >
                <span className="truncate">{org.name}</span>
                {currentOrg?.id === org.id && <CheckIcon className="h-4 w-4 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default OrgSwitcher;