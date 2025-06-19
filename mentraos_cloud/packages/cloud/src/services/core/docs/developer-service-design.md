# Developer Service Design Document

## Overview

The `developer.service.ts` will be a stateless service providing functions for developer console operations, particularly focused on API key and JWT generation. This service will extract developer-specific functionality from `app.service.ts` into a dedicated module within the `services/core/` directory.

## Current Implementation in app.service.ts

Currently, app.service.ts handles multiple developer-related functions that would be better placed in a dedicated service:

```typescript
// Creating new app entries with API keys
async createApp(appData: any, developerId: string): Promise<{ app: AppI, apiKey: string }> {
  // Implementation...
}

// Regenerating API keys for existing apps
async regenerateApiKey(packageName: string, developerId: string): Promise<string> {
  // Implementation...
}

// Validating API keys
async validateApiKey(packageName: string, apiKey: string, clientIp?: string): Promise<boolean> {
  // Implementation...
}

// Helper function for hashing API keys
hashApiKey(apiKey: string): string {
  // Implementation...
}
```

## Migration Strategy

1. Create a new `developer.service.ts` in `services/core/` with enhanced versions of these functions, including JWT generation
2. Keep `app.service.ts` untouched during the refactoring
3. Refactor any code that was using these functions in app.service.ts to use developer.service directly
4. After confirming the refactoring works perfectly, remove the unused functions from app.service.ts

## New Location

```
/packages/cloud/src/services/core/developer.service.ts
```

## Functions in developer.service.ts

```typescript
/**
 * Service for developer console operations
 * A collection of stateless functions for API key management and JWT generation
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { AppModel } from '../../models/app.model';
import { logger } from '../logging/pino-logger';

const serviceLogger = logger.child({ service: 'developer.service' });

// Environment variables
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

/**
 * Generate a hashed API key
 * @param apiKey - The API key to hash
 * @returns The hashed API key
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Generate a new API key for a TPA
 * @returns The generated API key
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a JWT token for TPA authentication
 * This JWT contains both packageName and apiKey, allowing TPAs to authenticate
 * with a single token instead of separate values.
 * 
 * @param packageName - The package name of the TPA
 * @param apiKey - The API key for the TPA
 * @returns The JWT token
 */
export function generateTpaJwt(packageName: string, apiKey: string): string {
  // Generate the JWT with packageName and apiKey
  return jwt.sign(
    { packageName, apiKey },
    AUGMENTOS_AUTH_JWT_SECRET
  );
}

/**
 * Validate an API key for a TPA
 * @param packageName - The package name of the TPA
 * @param apiKey - The API key to validate
 * @param clientIp - Optional client IP address for system app validation
 * @returns Whether the API key is valid
 */
export async function validateApiKey(
  packageName: string,
  apiKey: string,
  clientIp?: string
): Promise<boolean> {
  try {
    // Check if this is a system app (special validation rules)
    const isSystemApp = packageName.startsWith('org.augmentos.');
    
    // Find the app in the database
    const app = await AppModel.findOne({ packageName });
    if (!app) {
      serviceLogger.error(`App not found for package: ${packageName}`);
      return false;
    }
    
    // Special validation for system apps (IP restrictions)
    if (isSystemApp && clientIp) {
      // System app validation logic...
      // This preserves the existing IP validation logic for system apps
    }
    
    // Hash the provided API key and compare with stored hash
    const hashedKey = hashApiKey(apiKey);
    const isValid = hashedKey === app.apiKeyHash;
    
    if (!isValid) {
      serviceLogger.error(`Invalid API key for package: ${packageName}`);
    }
    
    return isValid;
  } catch (error) {
    serviceLogger.error(`Error validating API key for ${packageName}:`, error);
    return false;
  }
}

/**
 * Create a new app
 * Enhanced version that also generates a JWT
 * 
 * @param appData - The app data
 * @param developerId - The developer ID
 * @returns The created app, API key, and JWT
 */
export async function createApp(
  appData: any, 
  developerId: string
): Promise<{ app: AppI, apiKey: string, jwt: string }> {
  try {
    // Create a new app (similar to existing implementation)
    const newApp = new AppModel({
      ...appData,
      developerId
    });
    
    // Generate API key and hash
    const apiKey = generateApiKey();
    newApp.apiKeyHash = hashApiKey(apiKey);
    
    // Save the app
    await newApp.save();
    
    // Generate JWT
    const jwt = generateTpaJwt(newApp.packageName, apiKey);
    
    return {
      app: newApp,
      apiKey,
      jwt
    };
  } catch (error) {
    serviceLogger.error(`Error creating app:`, error);
    throw error;
  }
}

/**
 * Regenerate API key for an app
 * Enhanced version that also generates a JWT
 * 
 * @param packageName - The package name
 * @param developerId - The developer ID
 * @returns The new API key and JWT
 */
export async function regenerateApiKey(
  packageName: string, 
  developerId: string
): Promise<{ apiKey: string, jwt: string }> {
  try {
    // Find the app
    const app = await AppModel.findOne({ packageName, developerId });
    if (!app) {
      throw new Error(`App not found: ${packageName}`);
    }
    
    // Generate new API key and hash
    const apiKey = generateApiKey();
    app.apiKeyHash = hashApiKey(apiKey);
    
    // Save the app
    await app.save();
    
    // Generate JWT
    const jwt = generateTpaJwt(packageName, apiKey);
    
    return {
      apiKey,
      jwt
    };
  } catch (error) {
    serviceLogger.error(`Error regenerating API key:`, error);
    throw error;
  }
}

// Other developer-related functions as needed...
```

## Refactoring Routes

Any routes that currently use app.service.ts for developer-related operations will be updated to use developer.service.ts directly:

```typescript
// In routes/developer.routes.ts (existing file)

// Before:
import appService from '../services/core/app.service';

router.post('/app', authenticateUser, async (req, res) => {
  try {
    const { app, apiKey } = await appService.createApp(req.body, req.user.id);
    res.json({ app, apiKey });
  } catch (error) {
    handleApiError(res, error);
  }
});

// After:
import * as developerService from '../services/core/developer.service';

router.post('/app', authenticateUser, async (req, res) => {
  try {
    const { app, apiKey, jwt } = await developerService.createApp(req.body, req.user.id);
    res.json({ app, apiKey, jwt });
  } catch (error) {
    handleApiError(res, error);
  }
});
```

## Integration with New WebSocket Service

The new WebSocket service will use the developer.service directly for authentication:

```typescript
// In websocket/websocket.service.ts

import * as developerService from '../core/developer.service';

// During connection upgrade
if (authHeader && authHeader.startsWith('Bearer ')) {
  const tpaJwt = authHeader.substring(7);
  
  try {
    // Verify JWT signature
    const payload = jwt.verify(tpaJwt, AUGMENTOS_AUTH_JWT_SECRET) as { 
      packageName: string;
      apiKey: string;
    };
    
    // Validate API key using developer service
    const isValid = await developerService.validateApiKey(
      payload.packageName, 
      payload.apiKey,
      clientIp
    );
    
    if (!isValid) {
      // Handle invalid API key
    }
    
    // Continue with connection
  } catch (error) {
    // Handle JWT verification error
  }
}
```

## Functions to Eventually Remove from app.service.ts

Once we've confirmed the refactoring works perfectly, we'll remove these functions from app.service.ts:

```typescript
// Functions to eventually remove:
async createApp(appData: any, developerId: string): Promise<{ app: AppI, apiKey: string }>
async regenerateApiKey(packageName: string, developerId: string): Promise<string>
async validateApiKey(packageName: string, apiKey: string, clientIp?: string): Promise<boolean>
hashApiKey(apiKey: string): string
```

## Benefits

1. **Clean Separation**: Developer operations isolated from general app management
2. **Enhanced Functionality**: JWT generation added to existing functions
3. **Improved Architecture**: Functions grouped by responsibility
4. **Future Extensibility**: New service can evolve independently
5. **Reduced Complexity**: app.service.ts focused purely on app management