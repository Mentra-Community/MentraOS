import { Shield } from "lucide-react";
import PermissionsForm from "./PermissionsForm";
import { Permission } from "@/types/app";
import { ExternalLinkIcon } from "@/components/ui/icons";

interface PermissionsSectionProps {
  permissions: Permission[];
  onChange: (permissions: Permission[]) => void;
}

export function PermissionsSection({ permissions, onChange }: PermissionsSectionProps) {
  return (
    <div className="border rounded-lg p-5">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-base font-medium flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Required Permissions
        </h4>
        <a
          href="https://docs.mentraglass.com/app-devs/core-concepts/permissions"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-link hover:text-link-hover hover:underline flex items-center gap-1"
        >
          Learn about permissions
          <ExternalLinkIcon />
        </a>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        These are the permissions users will need to grant to your app.
      </p>
      <PermissionsForm permissions={permissions} onChange={onChange} />
    </div>
  );
}

export default PermissionsSection;
