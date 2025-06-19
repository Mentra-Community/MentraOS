/**
 * Migration script: Personal Organizations
 *
 * This migration:
 * 1. Creates a personal organization for each user
 * 2. Copies user profile data to the organization profile
 * 3. Updates all apps created by a user to reference their organization
 * 4. Makes each user an admin of their personal organization
 *
 * Usage:
 * ts-node -r tsconfig-paths/register scripts/migrations/001-personal-orgs.ts
 *
 * Add --dry-run to check what would happen without making changes
 * Add --email-filter=pattern to only process users with matching email (supports regex)
 * Add --force to migrate users even if they already have organizations
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../../src/models/user.model';
import { Organization } from '../../src/models/organization.model';
import App from '../../src/models/app.model';
import { logger as rootLogger } from '../../src/services/logging/pino-logger';

// Configure environment
dotenv.config();

const logger = rootLogger.child({ migration: '001-personal-orgs' });
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_MODE = process.argv.includes('--force');

// Parse email filter from command line arguments
const EMAIL_FILTER_ARG = process.argv.find(arg => arg.startsWith('--email-filter='));
const EMAIL_FILTER = EMAIL_FILTER_ARG ? EMAIL_FILTER_ARG.split('=')[1] : null;

if (DRY_RUN) {
  logger.info('DRY RUN MODE: No changes will be made to the database');
}

if (EMAIL_FILTER) {
  logger.info(`Email filter mode: Only processing users with email matching: ${EMAIL_FILTER}`);
}

if (FORCE_MODE) {
  logger.info('Force mode: Will create new personal orgs even for users who already have organizations');
}

/**
 * Creates a URL-safe slug from an organization name
 * @param name - The name to convert to a slug
 * @returns A URL-safe slug string
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Main migration function
 */
async function migrate() {
  try {
    // Connect to MongoDB
    const dbUri = process.env.MONGO_URL || 'mongodb://localhost:27017/augmentos';
    logger.info(`Connecting to MongoDB: ${dbUri}`);

    await mongoose.connect(dbUri);
    logger.info('Connected to MongoDB');

    // Initialize counters
    let userCount = 0;
    let orgCount = 0;
    let appCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const errors: any[] = [];

    // Construct query filter based on email pattern if provided
    const query: any = {};
    if (EMAIL_FILTER) {
      query.email = { $regex: EMAIL_FILTER };
    }

    // Process each user matching the filter
    logger.info('Starting user migration...');
    const userCursor = User.find(query).cursor();

    for await (const user of userCursor) {
      userCount++;
      logger.info(`Processing user ${userCount}: ${user.email}`);

      try {
        // Skip users who already have organizations linked (unless in force mode)
        if (!FORCE_MODE && user.organizations && user.organizations.length > 0) {
          logger.info(`User ${user.email} already has organizations, skipping`);
          skippedCount++;
          continue;
        }

        if (FORCE_MODE && user.organizations && user.organizations.length > 0) {
          logger.info(`User ${user.email} already has organizations, but force mode is enabled. Creating new org.`);
        }

        // 1. Create a personal org for this user
        const emailLocalPart = user.email.split('@')[0];
        // Use company name from profile if available, otherwise use default
        const orgName = user.profile?.company || `${emailLocalPart}'s Org`;
        const slug = generateSlug(orgName);

        // Check if org with this slug already exists
        const existingOrg = await Organization.findOne({ slug });
        if (existingOrg) {
          logger.warn(`Organization with slug ${slug} already exists, adding unique suffix`);
          // Add unique suffix
          const timestamp = new Date().getTime().toString().slice(-4);
          const uniqueSlug = `${slug}-${timestamp}`;
          logger.info(`Using unique slug: ${uniqueSlug}`);
        }

        // Prepare org data
        const orgData = {
          name: orgName,
          slug: existingOrg ? `${slug}-${new Date().getTime().toString().slice(-4)}` : slug,
          profile: {
            // Copy from user.profile if exists
            company: user.profile?.company || orgName,
            website: user.profile?.website || '',
            contactEmail: user.profile?.contactEmail || user.email,
            description: user.profile?.description || '',
            logo: user.profile?.logo || ''
          },
          members: [{
            user: user._id,
            role: 'admin',
            joinedAt: new Date()
          }]
        };

        // Create the organization (or just log in dry run)
        let personalOrg;
        if (!DRY_RUN) {
          personalOrg = await Organization.create(orgData);
          orgCount++;
          logger.info(`Created organization: ${personalOrg.name} (${personalOrg._id})`);
        } else {
          logger.info(`Would create organization: ${orgName}`);
          // Mock an ID for dry run to continue the flow
          personalOrg = { _id: new mongoose.Types.ObjectId(), name: orgName };
        }

        // 2. Update user with organization reference
        if (!DRY_RUN) {
          // If in force mode and user already has organizations, we add the new one
          // Otherwise, we replace the existing list with the new org
          if (FORCE_MODE && user.organizations && user.organizations.length > 0) {
            user.organizations.push(personalOrg._id);
          } else {
            user.organizations = [personalOrg._id];
          }
          user.defaultOrg = personalOrg._id;
          await user.save();
          logger.info(`Updated user ${user.email} with organization reference`);
        } else {
          logger.info(`Would update user ${user.email} with organization reference`);
        }

        // 3. Update all apps created by this user
        const appsQuery = { developerId: user.email };
        const appUpdate = {
          $set: { organizationId: personalOrg._id },
          // We're not removing the old fields yet for backward compatibility
          // $unset: { developerId: '', organizationDomain: '', sharedWithOrganization: '' }
        };

        // Count apps for this user
        const userAppCount = await App.countDocuments(appsQuery);

        if (!DRY_RUN) {
          const result = await App.updateMany(appsQuery, appUpdate);
          const updatedCount = result.modifiedCount;
          appCount += updatedCount;
          logger.info(`Updated ${updatedCount}/${userAppCount} apps for ${user.email}`);
        } else {
          logger.info(`Would update ${userAppCount} apps for ${user.email}`);
        }
      } catch (error: any) {
        errorCount++;
        logger.error(`Error processing user ${user.email}:`, error);
        errors.push({ user: user.email, error: error.message });
      }
    }

    // Log summary
    logger.info('=== Migration Summary ===');
    logger.info(`Processed ${userCount} users`);
    logger.info(`Created ${orgCount} organizations`);
    logger.info(`Updated ${appCount} apps`);
    logger.info(`Skipped ${skippedCount} users (already had organizations)`);
    logger.info(`Encountered ${errorCount} errors`);

    if (errorCount > 0) {
      logger.error('Errors encountered:', errors);
    }

    if (DRY_RUN) {
      logger.info('DRY RUN COMPLETE - No changes were made to the database');
    } else {
      logger.info('Migration completed successfully');
    }
  } catch (error) {
    logger.error('Migration failed with error:', error);
    process.exit(1);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  }
}

// Run the migration if this file is executed directly
if (require.main === module) {
  // Set timeout to 30 minutes to handle large datasets
  migrate().then(() => {
    process.exit(0);
  }).catch((error) => {
    logger.error('Unhandled error in migration:', error);
    process.exit(1);
  });
}

// Export for testing or importing
export { migrate };