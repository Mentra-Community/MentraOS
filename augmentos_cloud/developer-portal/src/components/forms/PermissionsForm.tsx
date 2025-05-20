import React from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

// Define our permission types
enum PermissionType {
  MICROPHONE = 'MICROPHONE',
  LOCATION = 'LOCATION',
  CALENDAR = 'CALENDAR',
  NOTIFICATIONS = 'NOTIFICATIONS',
  ALL = 'ALL'
}

// Permission interface matching our backend
export interface Permission {
  type: PermissionType;
  description?: string;
}

interface PermissionsFormProps {
  permissions: Permission[];
  onChange: (permissions: Permission[]) => void;
}

export function PermissionsForm({ permissions, onChange }: PermissionsFormProps) {
  const addPermission = () => {
    // Find the first available permission type not already in use
    const availablePermissionTypes = Object.values(PermissionType).filter(
      type => !permissions.some(p => p.type === type)
    );
    
    // If all permission types are used, don't add a new one
    if (availablePermissionTypes.length === 0) {
      return;
    }
    
    onChange([
      ...permissions,
      {
        type: availablePermissionTypes[0]
      }
    ]);
  };

  const updatePermission = (index: number, field: keyof Permission, value: any) => {
    const updatedPermissions = [...permissions];
    updatedPermissions[index] = {
      ...updatedPermissions[index],
      [field]: value
    };
    onChange(updatedPermissions);
  };

  const removePermission = (index: number) => {
    const updatedPermissions = [...permissions];
    updatedPermissions.splice(index, 1);
    onChange(updatedPermissions);
  };

  // Get a human-readable description for permissions
  const getPermissionDescription = (type: PermissionType): string => {
    switch (type) {
      case PermissionType.MICROPHONE:
        return 'Access to microphone for voice input and audio processing';
      case PermissionType.LOCATION:
        return 'Access to device location information';
      case PermissionType.CALENDAR:
        return 'Access to calendar events';
      case PermissionType.NOTIFICATIONS:
        return 'Access to phone notifications';
      case PermissionType.ALL:
        return 'Access to all available permissions';
      default:
        return 'Permission access';
    }
  };

  return (
    <Card className="shadow-sm border">
      <CardHeader>
        <CardTitle className="text-xl">Required Permissions</CardTitle>
        <CardDescription>
          Specify what permissions your app requires to function properly.
          Users will be informed of these permissions and will need to have them enabled to run your app.
        </CardDescription>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {permissions.length === 0 ? (
          <div className="text-center py-4 text-gray-500">
            No permissions added yet. Click "Add Permission" to specify required permissions.
          </div>
        ) : (
          permissions.map((permission, index) => (
            <div key={index} className="border rounded-md p-4 space-y-3">
              <div className="space-y-2">
                <Label htmlFor={`permission-type-${index}`}>Permission Type</Label>
                <Select
                  value={permission.type}
                  onValueChange={(value) => updatePermission(index, 'type', value)}
                >
                  <SelectTrigger id={`permission-type-${index}`}>
                    <SelectValue placeholder="Select permission type" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(PermissionType).map((type) => {
                      // Check if this permission type is already used in another permission
                      const isUsedElsewhere = permissions.some(
                        (p, i) => i !== index && p.type === type
                      );
                      
                      return (
                        <SelectItem 
                          key={type} 
                          value={type}
                          disabled={isUsedElsewhere}
                        >
                          {type}
                          {isUsedElsewhere ? ' (already added)' : ''}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  {getPermissionDescription(permission.type as PermissionType)}
                </p>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor={`permission-description-${index}`}>Description (Optional)</Label>
                <Textarea
                  id={`permission-description-${index}`}
                  value={permission.description || ''}
                  onChange={(e) => updatePermission(index, 'description', e.target.value)}
                  placeholder="Explain why your app needs this permission..."
                  rows={2}
                />
                <p className="text-xs text-gray-500">
                  A clear explanation helps users understand why this permission is necessary.
                </p>
              </div>
              
              <div className="pt-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => removePermission(index)}
                >
                  Remove Permission
                </Button>
              </div>
            </div>
          ))
        )}
        
        <Button
          type="button"
          variant="outline"
          onClick={addPermission}
          className="w-full mt-2"
          disabled={permissions.length >= Object.values(PermissionType).length}
        >
          {permissions.length >= Object.values(PermissionType).length ? 
            "All permission types added" : 
            "Add Permission"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default PermissionsForm;