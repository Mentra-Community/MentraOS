# Permissions System - Implementation Summary
Author: Isaiah Ballah

Status: Implemented

## 1. Overview

### Problem Statement

Currently, users have no visibility into what data TPAs (Third-Party Applications) access. When phone permissions are disabled, TPAs fail without clear error messages. Developers also lack a structured way to declare permission requirements.

This implementation focuses on the transparency and declaration aspects of the permission system without requiring client-side changes:

1. Allowing developers to declare required permissions
2. Displaying these permissions prominently in the app store
3. Including permission requirements when sending app data to clients 
4. Preventing duplicate permission declarations

## 2. Goals

**Implementation Targets:**

1. **Add Permission Schema**: Extend the App model with permission declarations
2. **Update Developer Console**: Add UI for developers to specify required/optional permissions
3. **Enhance App Store**: Display permission requirements in app listings
4. **Include in Client Communication**: Send permission requirements with app data to clients

## 3. Design

### Permission Types

We'll define a simplified set of permission types that directly map to OS-level permissions:

```typescript
export enum PermissionType {
  MICROPHONE = 'MICROPHONE',     // Microphone access for audio/speech features
  LOCATION = 'LOCATION',         // Location services access
  CALENDAR = 'CALENDAR',         // Calendar events access
  NOTIFICATIONS = 'NOTIFICATIONS', // Phone notification access
  ALL = 'ALL',                   // Convenience type requiring all permissions
}
```

### Permission Schema

For each permission, we'll store:
- The permission type
- A description explaining why the app needs this permission (optional)

In this initial implementation, all declared permissions will be treated as required.

```typescript
interface Permission {
  type: PermissionType;
  description?: string; // Optional field
}
```

## 4. Implementation Details

### App Model Extensions

Path: `/packages/cloud/src/models/app.model.ts`

```typescript
// Add to AppSchema
const AppSchema = new Schema({
  // Existing fields...
  
  // Add permissions array
  permissions: [{
    type: {
      type: String,
      enum: ['MICROPHONE', 'LOCATION', 'CALENDAR', 'NOTIFICATIONS', 'ALL'],
      required: true
    },
    description: {
      type: String,
      required: false
    }
  }]
}, { 
  strict: false,
  timestamps: true 
});
```

### SDK Type Extensions 

Path: `/packages/sdk/src/types/models.ts`

```typescript
// Add to existing types
export enum PermissionType {
  MICROPHONE = 'MICROPHONE',
  LOCATION = 'LOCATION',
  CALENDAR = 'CALENDAR',
  NOTIFICATIONS = 'NOTIFICATIONS',
  ALL = 'ALL'
}

export interface Permission {
  type: PermissionType;
  description?: string;
}

// Extend existing AppI interface
export interface AppI {
  // Existing fields...
  permissions?: Permission[];
}
```

### API Endpoints

Path: `/packages/cloud/src/routes/permissions.routes.ts`

```typescript
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import App from '../models/app.model';
import { PermissionType } from '@augmentos/sdk';

const router = Router();

// Update app permissions
router.patch('/:packageName', authMiddleware, async (req, res) => {
  try {
    const { packageName } = req.params;
    const { permissions } = req.body;
    
    // Validate permissions
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Permissions must be an array' });
    }
    
    // Validate each permission
    for (const perm of permissions) {
      if (!perm.type || !Object.values(PermissionType).includes(perm.type)) {
        return res.status(400).json({ error: `Invalid permission type: ${perm.type}` });
      }
      
      if (perm.description && typeof perm.description !== 'string') {
        return res.status(400).json({ error: 'Permission description must be a string' });
      }
    }
    
    // Update app permissions
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: { permissions } },
      { new: true }
    );
    
    if (!updatedApp) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    return res.json(updatedApp);
  } catch (error) {
    console.error('Error updating app permissions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get app permissions
router.get('/:packageName', async (req, res) => {
  try {
    const { packageName } = req.params;
    
    const app = await App.findOne({ packageName });
    
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    return res.json({ permissions: app.permissions || [] });
  } catch (error) {
    console.error('Error fetching app permissions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

This route should be registered in the main `index.ts` file:

```typescript
// In index.ts
import permissionsRoutes from './routes/permissions.routes';

// Add with other routes
app.use('/api/permissions', permissionsRoutes);
```
```

### Developer Console Updates

We created a new UI component for managing permissions in the developer portal:

Path: `/developer-portal/src/components/forms/PermissionsForm.tsx`

Key improvements in our implementation:

1. **Duplicate Prevention**: We enhanced the form to prevent developers from adding duplicate permissions:
   - The dropdown disables permission types that have already been selected
   - The "Add Permission" function intelligently selects the first available permission type
   - The "Add Permission" button is disabled when all permission types are already added

2. **Improved UX**: 
   - Each permission type has a default description that explains what it's used for
   - Descriptions are optional but strongly encouraged with clear placeholder text
   - Visual cues indicate which permissions are already added

3. **Error Handling**:
   - Validation on the frontend prevents invalid submissions
   - Type checking ensures permissions conform to the expected format

Here's a simplified view of the implementation:

```typescript
export function PermissionsForm({ permissions, onChange }: PermissionsFormProps) {
  // Intelligently add only available permission types
  const addPermission = () => {
    const availablePermissionTypes = Object.values(PermissionType).filter(
      type => !permissions.some(p => p.type === type)
    );
    
    if (availablePermissionTypes.length === 0) return;
    
    onChange([
      ...permissions,
      { type: availablePermissionTypes[0] }
    ]);
  };

  // Other handler functions...

  return (
    <Card>
      <CardHeader>
        <CardTitle>Required Permissions</CardTitle>
        <CardDescription>
          Specify what permissions your app requires to function properly.
        </CardDescription>
      </CardHeader>
      
      <CardContent>
        {permissions.map((permission, index) => (
          <div key={index}>
            <Select value={permission.type} onValueChange={...}>
              <SelectContent>
                {Object.values(PermissionType).map((type) => {
                  // Check if this permission type is already used elsewhere
                  const isUsedElsewhere = permissions.some(
                    (p, i) => i !== index && p.type === type
                  );
                  
                  return (
                    <SelectItem 
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
            
            {/* Description field... */}
            {/* Remove button... */}
          </div>
        ))}
        
        <Button 
          onClick={addPermission} 
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
```

This component would need to be integrated into the TPA creation/editing forms.

### App Store Updates

We developed a visually appealing permission display component for the app store:

Path: `/store/web/src/components/AppPermissions.tsx`

Key improvements in our implementation:

1. **Prominent Placement**:
   - Moved permissions to a dedicated section below the app description
   - Made the section more visible with appropriate spacing and layout
   - Ensured it's one of the first things users see when browsing an app

2. **Enhanced Visual Design**:
   - Added appropriate warning/info icons (shield icons)
   - Used a two-column grid layout for better space utilization
   - Implemented hover effects and modern card styling
   - Color-coded to indicate the importance of permissions (orange for required permissions)

3. **Improved Information Display**:
   - Each permission has a clear title and detailed description
   - Default descriptions are provided even when developers don't supply custom ones
   - "No permissions required" gets a positive green treatment to indicate this as a benefit

4. **Responsive Design**:
   - Column layout adapts to screen size (single column on mobile, two columns on larger screens)
   - Appropriate spacing and typography for all device sizes

```typescript
export function AppPermissions({ permissions }: AppPermissionsProps) {
  // Show a positive message for apps with no permissions
  if (!permissions || permissions.length === 0) {
    return (
      <div className="flex items-center bg-green-50 text-green-700 p-4 rounded-md border border-green-200">
        <Shield className="h-5 w-5 text-green-500 mr-3 flex-shrink-0" />
        <div>
          <p className="font-medium">No Special Permissions Required</p>
          <p className="text-sm text-green-600">
            This app doesn't require any special system permissions to function.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start mb-3">
        <ShieldAlert className="h-5 w-5 text-orange-500 mt-0.5 mr-2" />
        <p className="text-sm text-gray-600">
          This app requires the following permissions:
        </p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {permissions.map((permission, index) => (
          <div key={index} className="border border-gray-200 rounded-md p-4 bg-gray-50 hover:bg-gray-100 transition-colors">
            <p className="text-base font-semibold text-gray-800 mb-1">
              {permission.type}
            </p>
            <p className="text-sm text-gray-600">
              {permission.description || getPermissionDescription(permission.type)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

This component would be added to the app detail view in the app store.

### API and Backend Improvements

We made several important improvements to ensure permissions are correctly handled in the API:

1. **Mongoose Data Serialization Fix**:
   - Identified and fixed an issue where Mongoose document properties weren't being correctly serialized in API responses
   - Added `.lean()` to all MongoDB queries in `app.service.ts` to ensure documents are returned as plain JavaScript objects
   - Added proper conversion for existing documents using `.toObject()` when needed
   - Added debug logging to verify permissions are correctly included in API responses

2. **Authentication Middleware Update**:
   - Changed from using non-existent `authMiddleware` to the proper `validateCoreToken` middleware
   - Added ownership verification to ensure only the app's developer can modify its permissions
   - Added access control for viewing permissions (only published apps' permissions are visible to non-owners)

3. **Error Handling**:
   - Added detailed validation for permission structures
   - Improved error messages to provide clearer feedback
   - Added appropriate HTTP status codes for different error scenarios (401, 403, 404)

Key changes:

```typescript
// In getApp and findFromAppStore methods
async getApp(packageName: string): Promise<AppI | undefined> {
  // Use lean() to get a plain JavaScript object instead of a Mongoose document
  const app = await App.findOne({
    packageName: packageName
  }).lean() as AppI;
  
  return app;
}

// In route handlers, proper conversion if needed
const plainApp = typeof (app as any).toObject === 'function' 
  ? (app as any).toObject() 
  : app;

// Security checks for API endpoints
if (app.developerId && app.developerId !== userEmail) {
  return res.status(403).json({ 
    error: 'Unauthorized', 
    message: 'You do not have permission to modify this app' 
  });
}
```

## 5. User Experience

### Developer Experience

1. Developers visit the Developer Console
2. When creating or editing an app, they see a new "Required Permissions" section
3. They can add/remove permissions as needed
4. They can optionally add descriptions to explain why permissions are needed

### User Experience

1. Users visit the App Store
2. When viewing an app, they see what permissions it requires
3. Each permission includes an optional description of why it's needed
4. All permissions are displayed as required

## 6. Implementation Challenges and Solutions

During our implementation, we encountered and solved several technical challenges:

### Mongoose Document Serialization

**Challenge**: Mongoose documents weren't properly serializing nested objects like the permissions array when sent through the API. The permissions existed in the `_doc` property but weren't available at the top level.

**Solution**:
- Used `.lean()` in all MongoDB queries to get plain JavaScript objects
- Added proper document conversion using `.toObject()` when needed
- Temporarily adapted the frontend to handle both formats (checking both `app.permissions` and `app._doc.permissions`)

### Authentication Middleware

**Challenge**: Initially implemented with a non-existent `authMiddleware`, causing 401 Unauthorized errors.

**Solution**:
- Identified the correct middleware (`validateCoreToken`) by analyzing other API endpoints
- Updated the permissions routes to use the correct authentication approach
- Added proper security checks for app ownership

### Preventing Duplicate Permissions

**Challenge**: The initial implementation allowed developers to add duplicate permissions, which wouldn't make sense in a real app.

**Solution**:
- Enhanced the PermissionsForm component to prevent selecting already-used permission types
- Added intelligence to the "Add Permission" function to only add available types
- Added visual indicators in the UI to show which permissions are already in use

### UI Position and Visibility

**Challenge**: Initially placed permissions in a cramped sidebar, making them hard to notice and read.

**Solution**:
- Moved permissions to a dedicated section below the app description
- Created a more visually appealing layout with a card-based design
- Used color-coding and icons to make permissions more prominent

## 7. Future Enhancements

While our implementation provides a solid foundation, future enhancements could include the full permissions manager defined in
[AugmentOS/augmentos_cloud/packages/cloud/src/services/permissions/docs/permissions-manager.md](./permissions-manager.md)
