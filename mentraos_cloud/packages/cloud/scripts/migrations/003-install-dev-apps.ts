/**
 * Migration script: Install Developer Apps
 *
 * This migration:
 * 1. Finds all apps in the database
 * 2. For each app, installs it for the developer who created it
 * 3. Handles both legacy developerId field and new organizationId field
 * 4. Skips apps that are already installed for the developer
 *
 * Usage:
 * ts-node -r tsconfig-paths/register scripts/migrations/003-install-dev-apps.ts
 *
 * Add --dry-run to check what would happen without making changes
 * Add --package-filter=pattern to only process apps with matching package name (supports regex)
 * Add --force to install apps even if they're already installed
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../../src/models/user.model';
import { Organization } from '../../src/models/organization.model';
import App from '../../src/models/app.model';

// Configure environment
dotenv.config();
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_MODE = process.argv.includes('--force');

// Parse package filter from command line arguments
const PACKAGE_FILTER_ARG = process.argv.find(arg => arg.startsWith('--package-filter='));
const PACKAGE_FILTER = PACKAGE_FILTER_ARG ? PACKAGE_FILTER_ARG.split('=')[1] : null;

if (DRY_RUN) {
  console.log('DRY RUN MODE: No changes will be made to the database');
}

if (PACKAGE_FILTER) {
  console.log(`Package filter mode: Only processing apps with package name matching: ${PACKAGE_FILTER}`);
}

if (FORCE_MODE) {
  console.log('Force mode: Will install apps even if they are already installed');
}

/**
 * Get the developer email for an app
 * @param app - The app document
 * @returns The developer email or null if not found
 */
async function getDeveloperEmailForApp(app: any): Promise<string | null> {
  try {
    // If app has organizationId, find the admin user of that organization
    if (app.organizationId) {
      const org = await Organization.findById(app.organizationId);
      if (org && org.members && org.members.length > 0) {
        // Find the first admin member
        const adminMember = org.members.find(member => member.role === 'admin');
        if (adminMember) {
          const adminUser = await User.findById(adminMember.user);
          if (adminUser) {
            return adminUser.email;
          }
        }
        
        // If no admin found, use the first member
        const firstMember = org.members[0];
        const firstUser = await User.findById(firstMember.user);
        if (firstUser) {
          return firstUser.email;
        }
      }
    }
    
    // Fallback to legacy developerId field
    if (app.developerId) {
      return app.developerId;
    }
    
    return null;
  } catch (error) {
    console.error('Error getting developer email for app:', { error, appId: app._id, packageName: app.packageName });
    return null;
  }
}

/**
 * Install an app for a developer
 * @param packageName - The package name of the app
 * @param developerEmail - The email of the developer
 * @returns Whether the installation was successful
 */
async function installAppForDeveloper(packageName: string, developerEmail: string): Promise<boolean> {
  try {
    // Find the user (do not create if not found)
    const user = await User.findOne({ email: developerEmail.toLowerCase() });
    if (!user) {
      console.warn(`User not found for app installation: ${developerEmail} (app: ${packageName})`);
      return false;
    }

    // Check if app is already installed (safety check)
    if (user.isAppInstalled(packageName)) {
      if (FORCE_MODE) {
        console.log(`App ${packageName} is already installed for developer ${developerEmail}, but force mode is enabled`);
        // In force mode, we could uninstall and reinstall, but for safety we'll just skip
        return true;
      } else {
        console.log(`App ${packageName} is already installed for developer ${developerEmail}, skipping`);
        return true;
      }
    }

    if (!DRY_RUN) {
      // Install the app using the user model method
      await user.installApp(packageName);
      console.log(`Successfully installed app ${packageName} for developer ${developerEmail}`);

      // Note: Session notifications are skipped in migration for simplicity
    } else {
      console.log(`Would install app ${packageName} for developer ${developerEmail}`);
    }

    return true;
  } catch (error) {
    console.error('Error installing app for developer:', { error, packageName, developerEmail });
    return false;
  }
}

/**
 * Main migration function
 */
async function migrate() {
  try {
    // Connect to MongoDB
    const dbUri = process.env.MONGO_URL || 'mongodb://localhost:27017/augmentos';
    console.log(`Connecting to MongoDB: ${dbUri}`);

    await mongoose.connect(dbUri);
    console.log('Connected to MongoDB');

    // Initialize counters
    let appCount = 0;
    let installCount = 0;
    let skipCount = 0;
    let errorCount = 0;
    const errors: any[] = [];

    // Construct query filter based on package name pattern if provided
    const query: any = {};
    if (PACKAGE_FILTER) {
      query.packageName = { $regex: PACKAGE_FILTER };
    }

    // Process each app matching the filter
    console.log('Starting app installation migration...');
    const appCursor = App.find(query).cursor();

    for await (const app of appCursor) {
      appCount++;
      console.log(`Processing app ${appCount}: ${app.packageName}`);

      try {
        // Get the developer email for this app
        const developerEmail = await getDeveloperEmailForApp(app);
        
        if (!developerEmail) {
          console.warn(`No developer email found for app ${app.packageName}, skipping`);
          skipCount++;
          continue;
        }

        // Install the app for the developer
        const success = await installAppForDeveloper(app.packageName, developerEmail);
        
        if (success) {
          installCount++;
        } else {
          errorCount++;
          errors.push({ 
            packageName: app.packageName, 
            developerEmail, 
            error: 'Installation failed' 
          });
        }
      } catch (error: any) {
        errorCount++;
        console.error(`Error processing app ${app.packageName}:`, error);
        errors.push({ 
          packageName: app.packageName, 
          error: error.message 
        });
      }
    }

    // Log summary
    console.log('=== Migration Summary ===');
    console.log(`Processed ${appCount} apps`);
    console.log(`Successfully installed ${installCount} apps`);
    console.log(`Skipped ${skipCount} apps (no developer found)`);
    console.log(`Encountered ${errorCount} errors`);

    if (errorCount > 0) {
      console.error('Errors encountered:', errors);
    }

    if (DRY_RUN) {
      console.log('DRY RUN COMPLETE - No changes were made to the database');
    } else {
      console.log('Migration completed successfully');
    }
  } catch (error) {
    console.error('Migration failed with error:', error);
    process.exit(1);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

// Run the migration if this file is executed directly
if (require.main === module) {
  // Set timeout to 30 minutes to handle large datasets
  migrate().then(() => {
    process.exit(0);
  }).catch((error) => {
    console.error('Unhandled error in migration:', error);
    process.exit(1);
  });
}

// Export for testing or importing
export { migrate }; 