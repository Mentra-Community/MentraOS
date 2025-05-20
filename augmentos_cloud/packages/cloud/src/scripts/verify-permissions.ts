/**
 * Verification script to check the permissions status of all apps
 * 
 * This script checks if all apps have permissions defined and
 * provides a summary of the current permissions state in the database.
 * 
 * Usage: 
 *   bun run src/scripts/verify-permissions.ts
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import App, { PermissionType } from '../models/app.model';
import { logger } from '@augmentos/utils';
import * as mongoConnection from '../connections/mongodb.connection';

// Load environment variables
dotenv.config();

// Connect to MongoDB using the existing connection module
async function connectToDatabase() {
  try {
    logger.info('Initializing MongoDB connection');
    await mongoConnection.init();
    logger.info('Successfully connected to MongoDB');
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

// Verify permissions for all apps
async function verifyPermissions() {
  try {
    logger.info('Starting permissions verification...');
    
    // Get all apps
    const apps = await App.find({});
    logger.info(`Found ${apps.length} apps to verify`);
    
    // Statistics
    const stats = {
      total: apps.length,
      withPermissions: 0,
      withoutPermissions: 0,
      withAllPermission: 0,
      permissionCounts: {} as Record<string, number>
    };
    
    // Track apps without permissions
    const appsWithoutPermissions: string[] = [];
    
    // Verify each app
    for (const app of apps) {
      if (!app.permissions || app.permissions.length === 0) {
        stats.withoutPermissions++;
        appsWithoutPermissions.push(app.packageName);
      } else {
        stats.withPermissions++;
        
        // Check if app has ALL permission
        if (app.permissions.some(p => p.type === PermissionType.ALL)) {
          stats.withAllPermission++;
        }
        
        // Count each permission type
        app.permissions.forEach(permission => {
          const permType = permission.type;
          stats.permissionCounts[permType] = (stats.permissionCounts[permType] || 0) + 1;
        });
      }
    }
    
    // Print results
    logger.info(`
Permissions Verification Results:
------------------------------
Total apps: ${stats.total}
Apps with permissions: ${stats.withPermissions} (${((stats.withPermissions / stats.total) * 100).toFixed(2)}%)
Apps without permissions: ${stats.withoutPermissions} (${((stats.withoutPermissions / stats.total) * 100).toFixed(2)}%)
Apps with ALL permission: ${stats.withAllPermission} (${((stats.withAllPermission / stats.total) * 100).toFixed(2)}%)

Permission type distribution:
${Object.entries(stats.permissionCounts)
  .map(([type, count]) => `  - ${type}: ${count} apps (${((count / stats.total) * 100).toFixed(2)}%)`)
  .join('\n')}
    `);
    
    // Print apps without permissions if any
    if (appsWithoutPermissions.length > 0) {
      logger.warn(`
The following apps still have no permissions defined:
${appsWithoutPermissions.map(name => `  - ${name}`).join('\n')}
      `);
    }
    
  } catch (error) {
    logger.error('Error during verification:', error);
    process.exit(1);
  }
}

// Main function
async function main() {
  try {
    await connectToDatabase();
    await verifyPermissions();
    logger.info('Verification completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Verification failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the script
main();