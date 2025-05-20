import React from 'react';
import { Shield, ShieldAlert } from 'lucide-react';

// Define permission types matching our backend
export enum PermissionType {
  MICROPHONE = 'MICROPHONE',
  LOCATION = 'LOCATION',
  CALENDAR = 'CALENDAR',
  NOTIFICATIONS = 'NOTIFICATIONS',
  ALL = 'ALL'
}

// Permission interface matching our backend
export interface Permission {
  type: PermissionType | string;
  description?: string;
}

interface AppPermissionsProps {
  permissions?: Array<{
    type: string;
    description?: string;
  }>;
}

// Get a human-readable description for permissions
const getPermissionDescription = (type: string): string => {
  switch (type) {
    case 'MICROPHONE':
      return 'Access to microphone for voice input and audio processing';
    case 'LOCATION':
      return 'Access to device location information';
    case 'CALENDAR':
      return 'Access to calendar events';
    case 'NOTIFICATIONS':
      return 'Access to phone notifications';
    case 'ALL':
      return 'Access to all available permissions';
    default:
      return 'Permission access';
  }
};

export function AppPermissions({ permissions }: AppPermissionsProps) {
  // If no permissions, display that this app doesn't require special permissions
  if (!permissions || permissions.length === 0) {
    return (
      <div className="flex items-center bg-green-50 text-green-700 p-4 rounded-md border border-green-200">
        <Shield className="h-5 w-5 text-green-500 mr-3 flex-shrink-0" />
        <div>
          <p className="font-medium">No Special Permissions Required</p>
          <p className="text-sm text-green-600">This app doesn't require any special system permissions to function.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start mb-3">
        <ShieldAlert className="h-5 w-5 text-orange-500 mt-0.5 mr-2" />
        <p className="text-sm text-gray-600">This app requires the following permissions:</p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {permissions.map((permission, index) => (
          <div key={index} className="border border-gray-200 rounded-md p-4 bg-gray-50 hover:bg-gray-100 transition-colors">
            <p className="text-base font-semibold text-gray-800 mb-1">{permission.type}</p>
            <p className="text-sm text-gray-600">
              {permission.description || getPermissionDescription(permission.type)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AppPermissions;