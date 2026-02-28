import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Shield, Plus, Trash2 } from "lucide-react";
import { PermissionType, Permission } from "../../types/app";

// Permission display metadata
const PERMISSION_DISPLAY_INFO: Record<
  PermissionType,
  {
    label: string;
    description: string;
    isLegacy: boolean;
    category: string;
    replacedBy?: PermissionType[];
    isSelectable?: boolean;
  }
> = {
  [PermissionType.NOTIFICATIONS]: {
    label: "Notifications (Legacy)",
    description:
      "Read phone notifications (deprecated - use READ_NOTIFICATIONS)",
    isLegacy: true,
    replacedBy: [PermissionType.READ_NOTIFICATIONS],
    category: "phone",
  },
  [PermissionType.READ_NOTIFICATIONS]: {
    label: "Read Notifications",
    description: "Access incoming phone notifications",
    isLegacy: false,
    category: "phone",
  },
  [PermissionType.POST_NOTIFICATIONS]: {
    label: "Send Notifications",
    description: "Send notifications to the phone",
    isLegacy: false,
    category: "phone",
  },
  [PermissionType.MICROPHONE]: {
    label: "Microphone",
    description: "Access to microphone for voice input and audio processing",
    isLegacy: false,
    category: "audio",
  },
  [PermissionType.LOCATION]: {
    label: "Location",
    description: "Access to device location information",
    isLegacy: false,
    category: "location",
  },
  [PermissionType.BACKGROUND_LOCATION]: {
    label: "Background Location",
    description:
      "Access to device location information when the app is in the background",
    isLegacy: false,
    category: "location",
  },
  [PermissionType.CALENDAR]: {
    label: "Calendar",
    description: "Access to calendar events",
    isLegacy: false,
    category: "calendar",
  },
  [PermissionType.CAMERA]: {
    label: "Camera",
    description: "Access to camera for photo capture and video streaming",
    isLegacy: false,
    category: "camera",
  },
  [PermissionType.ALL]: {
    label: "All Permissions (Deprecated)",
    description: "Access to all available permissions - no longer selectable",
    isLegacy: false,
    category: "system",
    isSelectable: false,
  },
};

// Check if a permission type is selectable
const isPermissionSelectable = (type: PermissionType): boolean => {
  return PERMISSION_DISPLAY_INFO[type]?.isSelectable !== false;
};

// Human-friendly label for permissions (avoid showing raw enum values)
const getPermissionLabel = (type: PermissionType): string => {
  if (type === PermissionType.MICROPHONE) {
    return "Microphone + Transcripts";
  }
  return PERMISSION_DISPLAY_INFO[type]?.label ?? String(type);
};

interface PermissionsFormProps {
  permissions: Permission[];
  onChange: (permissions: Permission[]) => void;
}

/**
 * Compact permission item component with mobile-friendly expandable editing
 */
interface PermissionItemProps {
  permission: Permission;
  index: number;
  isEditing: boolean;
  onEditToggle: (index: number | null) => void;
  removePermission: (index: number) => void;
  updatePermission: (
    index: number,
    field: keyof Permission,
    value: string,
  ) => void;
  availableTypes: PermissionType[];
}

const PermissionItem: React.FC<PermissionItemProps> = ({
  permission,
  index,
  isEditing,
  onEditToggle,
  removePermission,
  updatePermission,
  availableTypes,
}) => {
  // Get a human-readable description for permissions
  const getPermissionDescription = (type: PermissionType): string => {
    const info = PERMISSION_DISPLAY_INFO[type];
    if (info) {
      return info.isLegacy ? `${info.description} ⚠️` : info.description;
    }

    // Fallback for any unmapped permissions
    switch (type) {
      case PermissionType.MICROPHONE:
        return "Access to microphone for voice input and audio processing";
      case PermissionType.LOCATION:
        return "Access to device location information";
      case PermissionType.BACKGROUND_LOCATION:
        return "Access to device location information even when the app is in the background";
      case PermissionType.CALENDAR:
        return "Access to calendar events";
      case PermissionType.NOTIFICATIONS:
        return "Read phone notifications (legacy - consider READ_NOTIFICATIONS)";
      case PermissionType.READ_NOTIFICATIONS:
        return "Read incoming phone notifications";
      case PermissionType.POST_NOTIFICATIONS:
        return "Send notifications to the phone";
      case PermissionType.ALL:
        return "Access to all available permissions";
      default:
        return "Permission access";
    }
  };

  // Helper function to get description preview
  const getDescriptionPreview = () => {
    if (permission.description && permission.description.trim()) {
      return permission.description.length > 50
        ? permission.description.substring(0, 50) + "..."
        : permission.description;
    }
    return getPermissionDescription(permission.type);
  };

  return (
    <div className="border rounded-lg bg-white shadow-sm">
      {!isEditing ? (
        // Collapsed view - just show the essential info
        <div
          className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={() => onEditToggle(index)}
        >
          <div className="flex items-center gap-3">
            {/* Content preview */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="h-4 w-4 text-blue-600 flex-shrink-0" />
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  {getPermissionLabel(permission.type)}
                </span>
                {PERMISSION_DISPLAY_INFO[permission.type]?.isLegacy && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                    Legacy
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {getDescriptionPreview()}
              </div>
              {PERMISSION_DISPLAY_INFO[permission.type]?.isLegacy && (
                <div className="text-xs text-orange-600 mt-1">
                  💡 Consider migrating to:{" "}
                  {PERMISSION_DISPLAY_INFO[permission.type]?.replacedBy
                    ?.map((t) => getPermissionLabel(t))
                    .join(", ")}
                </div>
              )}
            </div>

            {/* Delete button */}
            <Button
              onClick={(e) => {
                e.stopPropagation();
                removePermission(index);
              }}
              variant="ghost"
              size="sm"
              type="button"
              className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        // Expanded editing view
        <div className="p-4">
          {/* Header with close button */}
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Edit Permission
            </h4>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => onEditToggle(null)}
                variant="outline"
                size="sm"
                type="button"
                className="h-8 px-3 text-xs"
              >
                Done
              </Button>
              <Button
                onClick={() => removePermission(index)}
                variant="ghost"
                size="sm"
                type="button"
                className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Form fields */}
          <div className="space-y-4">
            {/* Permission Type */}
            <div>
              <Label className="text-sm font-medium">Permission Type</Label>
              <Select
                value={permission.type}
                onValueChange={(value) =>
                  updatePermission(index, "type", value)
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select permission type" />
                </SelectTrigger>
                <SelectContent>
                  {/* Available types for new/existing permissions */}
                  {availableTypes.map((type) => {
                    const isSelectable = isPermissionSelectable(type);
                    return (
                      <SelectItem
                        key={type}
                        value={type}
                        disabled={!isSelectable}
                        className={
                          !isSelectable
                            ? "text-gray-400 cursor-not-allowed"
                            : ""
                        }
                      >
                        {getPermissionLabel(type)}
                        {!isSelectable ? " (Deprecated - Not Selectable)" : ""}
                      </SelectItem>
                    );
                  })}

                  {/* Current legacy type (only if editing existing legacy permission) */}
                  {PERMISSION_DISPLAY_INFO[permission.type]?.isLegacy && (
                    <SelectItem value={permission.type}>
                      {permission.type} (Legacy - Consider migrating)
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>

              {PERMISSION_DISPLAY_INFO[permission.type]?.isLegacy && (
                <div className="mt-2 p-3 bg-orange-50 border border-orange-200 rounded-md">
                  <div className="text-sm text-orange-800">
                    ⚠️ This is a legacy permission. Consider migrating to{" "}
                    {PERMISSION_DISPLAY_INFO[permission.type]?.replacedBy
                      ?.map((t) => getPermissionLabel(t))
                      .join(", ")}{" "}
                    for better clarity.
                  </div>
                </div>
              )}

              <p className="text-xs text-gray-500 mt-1">
                {getPermissionDescription(permission.type as PermissionType)}
              </p>
            </div>

            {/* Description */}
            <div>
              <Label className="text-sm font-medium">
                Description (Optional)
              </Label>
              <Textarea
                value={permission.description || ""}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  updatePermission(index, "description", e.target.value)
                }
                placeholder="Explain why your app needs this permission..."
                rows={3}
                className="mt-1"
              />
              <p className="text-xs text-gray-500 mt-1">
                A clear explanation helps users understand why this permission
                is necessary.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Compact permissions form component with mobile-friendly design
 */
export function PermissionsForm({
  permissions,
  onChange,
}: PermissionsFormProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Helper function to create a new empty permission
  const createEmptyPermission = (type: PermissionType): Permission => ({
    type,
    description: "",
  });

  // Get available permission types for NEW permission selection (excludes legacy but includes unselectable)
  const getAvailablePermissionTypes = (
    excludeIndex?: number,
  ): PermissionType[] => {
    return Object.values(PermissionType).filter((type) => {
      // Exclude legacy permissions from new selections
      if (PERMISSION_DISPLAY_INFO[type]?.isLegacy) return false;

      // Exclude already used permissions
      return !permissions.some((p, i) => p.type === type && i !== excludeIndex);
    });
  };

  // Add a new permission
  const addPermission = () => {
    const availableTypes = getAvailablePermissionTypes();

    // If all permission types are used, don't add a new one
    if (availableTypes.length === 0) {
      return;
    }

    const newPermission = createEmptyPermission(availableTypes[0]);
    const newPermissions = [...permissions, newPermission];
    onChange(newPermissions);
    // Auto-expand the newly added permission for editing
    setEditingIndex(newPermissions.length - 1);
  };

  // Remove a permission
  const removePermission = (index: number) => {
    const newPermissions = permissions.filter((_, i) => i !== index);
    onChange(newPermissions);
    // If we're removing the currently editing item, clear the editing state
    if (editingIndex === index) {
      setEditingIndex(null);
    } else if (editingIndex !== null && editingIndex > index) {
      // If we're removing an item before the currently editing one, adjust the index
      setEditingIndex(editingIndex - 1);
    }
  };

  // Update a permission
  const updatePermission = (
    index: number,
    field: keyof Permission,
    value: string,
  ) => {
    const updatedPermissions = [...permissions];
    updatedPermissions[index] = {
      ...updatedPermissions[index],
      [field]: value,
    };
    onChange(updatedPermissions);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Required Permissions
          </h3>
          <p className="text-sm text-gray-600">
            Specify what permissions your app requires to function properly.
          </p>
        </div>
        <Button
          onClick={addPermission}
          size="sm"
          type="button"
          className="h-8 px-3"
          disabled={getAvailablePermissionTypes().length === 0}
        >
          <Plus className="h-4 w-4 mr-1" />
          {getAvailablePermissionTypes().length === 0
            ? "All Added"
            : "Add Permission"}
        </Button>
      </div>

      {permissions.length === 0 ? (
        <div className="text-center py-4 text-gray-500">
          <p>No permissions added yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {permissions.map((permission, index) => (
            <PermissionItem
              key={index}
              permission={permission}
              index={index}
              isEditing={editingIndex === index}
              onEditToggle={setEditingIndex}
              removePermission={removePermission}
              updatePermission={updatePermission}
              availableTypes={getAvailablePermissionTypes(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default PermissionsForm;
