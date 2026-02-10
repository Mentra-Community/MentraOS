// cloud/src/models/user.model.ts
import mongoose, { Schema, Document, Model, Types } from "mongoose";
import { type AppSetting } from "@mentra/sdk";
import { MongoSanitizer } from "../utils/mongoSanitizer";
import { logger } from "../services/logging/pino-logger";

interface Location {
  lat: number;
  lng: number;
  accuracy?: number;
  timestamp?: Date;
}

interface InstalledApp {
  packageName: string;
  installedDate: Date;
  lastActiveAt?: Date;
}

// Extend Document for TypeScript support
export interface UserI extends Document {
  email: string;
  runningApps: string[];
  appSettings: Map<string, AppSetting[]>;
  augmentosSettings: {
    useOnboardMic: boolean;
    contextualDashboard: boolean;
    headUpAngle: number;
    dashboardHeight: number;
    dashboardDepth: number;
    brightness: number;
    autoBrightness: boolean;
    sensingEnabled: boolean;
    alwaysOnStatusBar: boolean;
    bypassVad: boolean;
    bypassAudioEncoding: boolean;
    metricSystemEnabled: boolean;
    enforceLocalTranscription: boolean;
  };
  location?: Location;
  locationSubscriptions?: Map<string, { rate: string }>;
  effectiveLocationTier?: string;
  installedApps?: Array<{
    packageName: string;
    installedDate: Date;
    lastActiveAt?: Date;
  }>;

  /**
   * Organizations this user belongs to
   * @since 2.0.0
   */
  organizations?: Types.ObjectId[];

  /**
   * Default organization for this user (typically personal org)
   * @since 2.0.0
   */
  defaultOrg?: Types.ObjectId;

  /**
   * Developer profile information
   * @deprecated Use organization.profile instead. Will be removed after migration.
   */
  profile?: {
    company?: string;
    website?: string;
    contactEmail?: string;
    description?: string;
    logo?: string;
  };

  /**
   * Maps App package names to onboarding completion status for this user.
   * Example: { "org.example.myapp": true, "org.other.app": false }
   */
  onboardingStatus?: Record<string, boolean>;

  /**
   * List of glasses models that this user has connected
   * Example: ["Even Realities G1", "TCL RayNeo X2", "Vuzix Shield"]
   */
  glassesModels?: string[];

  setLocation(location: Location): Promise<void>;
  addRunningApp(appName: string): Promise<void>;
  removeRunningApp(appName: string): Promise<void>;
  updateAppSettings(
    appName: string,
    settings: { key: string; value: any }[],
  ): Promise<void>;
  // getAppSettings(appName: string): AppSetting[] | undefined;
  getAppSettings(appName: string): any[] | undefined;
  isAppRunning(appName: string): boolean;

  // New methods for installed apps
  installApp(packageName: string): Promise<void>;
  uninstallApp(packageName: string): Promise<void>;
  isAppInstalled(packageName: string): boolean;

  updateAugmentosSettings(
    settings: Partial<UserI["augmentosSettings"]>,
  ): Promise<void>;
  getAugmentosSettings(): UserI["augmentosSettings"];
  updateAppLastActive(packageName: string): Promise<void>;

  // Glasses model tracking methods
  addGlassesModel(modelName: string): Promise<void>;
  getGlassesModels(): string[];
}

const InstalledAppSchema = new Schema({
  packageName: { type: String, required: true },
  installedDate: { type: Date, default: Date.now },
  lastActiveAt: { type: Date },
});

// --- New Schema for Lightweight Updates ---
const AppSettingUpdateSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

// // Setting schemas (unchanged)
// const ToggleSettingSchema = new Schema({
//   type: { type: String, enum: ['toggle'], required: true },
//   key: { type: String, required: true },
//   label: { type: String, required: true },
//   defaultValue: { type: Boolean, required: true }
// });

// const TextSettingSchema = new Schema({
//   type: { type: String, enum: ['text'], required: true },
//   key: { type: String, required: true },
//   label: { type: String, required: true },
//   defaultValue: { type: String }
// });

// const SelectOptionSchema = new Schema({
//   label: { type: String, required: true },
//   value: { type: String, required: true }
// });

// const SelectSettingSchema = new Schema({
//   type: { type: String, enum: ['select'], required: true },
//   key: { type: String, required: true },
//   label: { type: String, required: true },
// });

// --- User Schema ---
const UserSchema = new Schema<UserI>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (email: string) => {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        },
        message: "Invalid email format",
      },
    },
    augmentosSettings: {
      type: {
        useOnboardMic: { type: Boolean, default: false },
        contextualDashboard: { type: Boolean, default: true },
        metricSystemEnabled: { type: Boolean, default: false },
        headUpAngle: { type: Number, default: 20 },
        dashboardHeight: { type: Number, default: 4 },
        dashboardDepth: { type: Number, default: 5 },
        brightness: { type: Number, default: 50 },
        autoBrightness: { type: Boolean, default: false },
        sensingEnabled: { type: Boolean, default: true },
        alwaysOnStatusBar: { type: Boolean, default: false },
        bypassVad: { type: Boolean, default: false },
        bypassAudioEncoding: { type: Boolean, default: false },
        enforceLocalTranscription: { type: Boolean, default: false },
      },
      default: function () {
        return {
          useOnboardMic: false,
          contextualDashboard: true,
          metricSystemEnabled: false,
          headUpAngle: 20,
          dashboardHeight: 4,
          dashboardDepth: 5,
          brightness: 50,
          autoBrightness: false,
          sensingEnabled: true,
          alwaysOnStatusBar: false,
          bypassVad: false,
          bypassAudioEncoding: false,
          enforceLocalTranscription: false,
        };
      },
    },
    // Cache location so timezones can be calculated by dashboard manager immediately.
    location: {
      type: {
        lat: { type: Number, required: true },
        lng: { type: Number, required: true },
        accuracy: { type: Number, required: false },
        timestamp: { type: Date, required: false },
      },
    },

    locationSubscriptions: {
      type: Map,
      of: new Schema(
        {
          rate: {
            type: String,
            required: true,
            enum: [
              "reduced",
              "threeKilometers",
              "kilometer",
              "hundredMeters",
              "tenMeters",
              "high",
              "realtime",
              "standard",
            ],
          },
        },
        { _id: false },
      ),
      default: new Map(),
    },

    effectiveLocationTier: {
      type: String,
      default: "reduced",
      enum: [
        "reduced",
        "threeKilometers",
        "kilometer",
        "hundredMeters",
        "tenMeters",
        "high",
        "realtime",
        "standard",
      ],
    },

    /**
     * List of organizations this user belongs to
     */
    organizations: {
      type: [{ type: Schema.Types.ObjectId, ref: "Organization" }],
      default: [],
      index: true,
    },

    /**
     * Default organization for this user (typically their personal org)
     */
    defaultOrg: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },

    /**
     * Developer profile information
     * @deprecated Use organization.profile instead
     */
    profile: {
      company: { type: String, required: false }, // Not required in schema, but validated in app publish flow
      website: { type: String },
      contactEmail: { type: String, required: false }, // Not required in schema, but validated in app publish flow
      description: { type: String },
      logo: { type: String },
    },

    runningApps: {
      type: [String],
      default: [],
      validate: {
        validator: function (apps: string[]) {
          return new Set(apps).size === apps.length;
        },
        message: "Running apps must be unique",
      },
    },
    appSettings: {
      type: Map,
      of: [AppSettingUpdateSchema], // Use the new schema for updates
      default: new Map(),
    },

    installedApps: {
      type: [InstalledAppSchema],
      default: [],
      validate: {
        validator: function (apps: InstalledApp[]) {
          // Ensure no duplicate package names
          const packageNames = apps.map((app) => app.packageName);
          return new Set(packageNames).size === packageNames.length;
        },
        message: "Installed apps must be unique",
      },
    },

    onboardingStatus: {
      type: Map,
      of: Boolean,
      default: {},
    },

    glassesModels: {
      type: [String],
      default: [],
      validate: {
        validator: function (models: string[]) {
          return new Set(models).size === models.length;
        },
        message: "Glasses models must be unique",
      },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        ret.id = ret._id;
        delete ret._id;
        // Safely handle appSettings transformation
        if (ret.appSettings && ret.appSettings instanceof Map) {
          ret.appSettings = Object.fromEntries(ret.appSettings);
        } else {
          ret.appSettings = {};
        }
        return ret;
      },
    },
  },
);

// // Add discriminators
// AppSettingUpdateSchema.discriminator('toggle', ToggleSettingSchema);
// AppSettingUpdateSchema.discriminator('text', TextSettingSchema);
// AppSettingUpdateSchema.discriminator('select', SelectSettingSchema);

// Create compound index for unique running apps per user
UserSchema.index({ email: 1, runningApps: 1 }, { unique: true });

// Instance methods

// Install / uninstall.
// Add methods for managing installed apps
UserSchema.methods.installApp = async function (
  this: UserI,
  packageName: string,
): Promise<void> {
  if (!this.isAppInstalled(packageName)) {
    if (!this.installedApps) {
      this.installedApps = [];
    }
    this.installedApps.push({
      packageName,
      installedDate: new Date(),
    });
    await this.save();
  }
};

UserSchema.methods.uninstallApp = async function (
  this: UserI,
  packageName: string,
): Promise<void> {
  if (this.isAppInstalled(packageName)) {
    if (!this.installedApps) {
      this.installedApps = [];
    }
    this.installedApps = this.installedApps.filter(
      (app) => app.packageName !== packageName,
    );
    await this.save();
  }
};

UserSchema.methods.isAppInstalled = function (
  this: UserI,
  packageName: string,
): boolean {
  return (
    this.installedApps?.some((app) => app.packageName === packageName) ?? false
  );
};

// Update location.
UserSchema.methods.setLocation = async function (
  this: UserI,
  location: Location,
): Promise<void> {
  this.location = location;
  await this.save();
};

UserSchema.methods.addRunningApp = async function (
  this: UserI,
  appName: string,
): Promise<void> {
  if (!this.runningApps.includes(appName)) {
    this.runningApps.push(appName);
    await this.save();
  }
};

UserSchema.methods.removeRunningApp = async function (
  this: UserI,
  appName: string,
): Promise<void> {
  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Re-fetch the user document to get the latest version
      const freshUser = await (this.constructor as any).findOne({
        _id: this._id,
      });
      if (!freshUser) {
        throw new Error(`User ${this.email} not found during removeRunningApp`);
      }

      if (freshUser.runningApps.includes(appName)) {
        freshUser.runningApps = freshUser.runningApps.filter(
          (app: string) => app !== appName,
        );
        await freshUser.save();
        return;
      }
      // App not in running apps, nothing to do
      return;
    } catch (error: any) {
      lastError = error;

      // If it's a version conflict, retry
      if (error.name === "VersionError") {
        logger.warn(
          `Version conflict in removeRunningApp for user ${this.email}, app ${appName}, attempt ${attempt + 1}/${maxRetries}`,
        );
        if (attempt < maxRetries - 1) {
          // Wait a bit before retrying (exponential backoff)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 50),
          );
          continue;
        }
      }

      // For other errors or max retries reached, throw
      throw error;
    }
  }

  // If we get here, all retries failed
  throw lastError;
};

// UserSchema.methods.updateAppSettings = async function (
//   this: UserDocument,
//   appName: string,
//   settings: AppSetting[]
// ): Promise<void> {
//   // Validate settings before updating
//   const isValid = settings.every(setting => {
//     switch (setting.type) {
//       case AppSettingType.TOGGLE:
//         return typeof setting.defaultValue === 'boolean';
//       case AppSettingType.SELECT:
//         return Array.isArray(setting.options) &&
//           setting.options.length > 0 &&
//           (!setting.defaultValue || setting.options.some(opt => opt.value === setting.defaultValue));
//       case AppSettingType.TEXT:
//         return true; // Text settings can have any string default value
//       default:
//         return false;

UserSchema.methods.updateAppSettings = async function (
  appName: string,
  settings: { key: string; value: any }[],
): Promise<void> {
  console.log(
    "Settings update payload (before saving):",
    JSON.stringify(settings),
  );

  // Sanitize the appName since it's used as a Map key
  const sanitizedAppName = MongoSanitizer.sanitizeKey(appName);

  console.log("App name:", sanitizedAppName);

  // Retrieve existing settings and convert subdocuments to plain objects.
  const existingSettings = this.appSettings.get(sanitizedAppName);
  let existingSettingsPlain: { key: string; value: any }[] = [];
  if (existingSettings && Array.isArray(existingSettings)) {
    existingSettingsPlain = existingSettings.map((s: any) =>
      typeof s.toObject === "function" ? s.toObject() : s,
    );
  }

  // Create a map from the existing settings.
  const existingSettingsMap = new Map(
    existingSettingsPlain.map((s) => [s.key, s.value]),
  );

  // Merge updates from the payload.
  settings.forEach((update) => {
    if (update.key !== undefined) {
      // extra guard to prevent undefined keys
      existingSettingsMap.set(update.key, update.value);
    }
  });

  // Convert the merged map back into an array of settings.
  const updatedSettingsArray = Array.from(existingSettingsMap.entries()).map(
    ([key, value]) => ({ key, value }),
  );

  // Use the merged settings array instead of just the new settings
  this.appSettings.set(sanitizedAppName, updatedSettingsArray);
  await this.save();

  console.log("Updated settings:", JSON.stringify(updatedSettingsArray));
  const afterUpdate = this.appSettings.get(sanitizedAppName);
  console.log("Settings retrieved after save:", JSON.stringify(afterUpdate));

  return afterUpdate;
};

UserSchema.methods.getAppSettings = function (
  this: UserI,
  appName: string,
): AppSetting[] | undefined {
  const sanitizedAppName = MongoSanitizer.sanitizeKey(appName);
  const settings = this.appSettings.get(sanitizedAppName);
  return settings;
};

UserSchema.methods.isAppRunning = function (
  this: UserI,
  appName: string,
): boolean {
  return this.runningApps.includes(appName);
};

UserSchema.methods.updateAugmentosSettings = async function (
  this: UserI,
  settings: Partial<UserI["augmentosSettings"]>,
): Promise<void> {
  // Convert to plain objects for clean logging
  const currentSettingsClean = JSON.parse(
    JSON.stringify(this.augmentosSettings),
  );
  const newSettingsClean = JSON.parse(JSON.stringify(settings));

  logger.info(
    {
      userId: this.email,
      currentSettings: currentSettingsClean,
      newSettings: newSettingsClean,
    },
    "Updating AugmentOS settings:",
  );

  // Directly apply each setting to ensure updates happen properly
  Object.entries(settings).forEach(([key, value]) => {
    if (value !== undefined) {
      // @ts-ignore - We're dynamically updating the settings
      this.augmentosSettings[key] = value;
    }
  });

  // Convert to plain object for clean logging
  const mergedSettingsClean = JSON.parse(
    JSON.stringify(this.augmentosSettings),
  );
  logger.info({ mergedSettingsClean }, "Merged settings:");

  await this.save();
  logger.info("Settings saved successfully");
};

UserSchema.methods.getAugmentosSettings = function (
  this: UserI,
): UserI["augmentosSettings"] {
  return this.augmentosSettings;
};

// Update last active timestamp for an app
UserSchema.methods.updateAppLastActive = async function (
  this: UserI,
  packageName: string,
): Promise<void> {
  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Re-fetch the user document to get the latest version
      const freshUser = await (this.constructor as any).findOne({
        _id: this._id,
      });
      if (!freshUser) {
        throw new Error(
          `User ${this.email} not found during updateAppLastActive`,
        );
      }

      if (!freshUser.installedApps) {
        freshUser.installedApps = [];
      }

      const app = freshUser.installedApps.find(
        (app: any) => app.packageName === packageName,
      );

      if (app) {
        // App exists in list, update timestamp
        app.lastActiveAt = new Date();
        await freshUser.save();
        return;
      } else {
        // Check if this is a pre-installed app that's missing from user's list
        try {
          const {
            getPreInstalledForThisServer,
          } = require("../services/core/app.service");
          const serverPreInstalled = getPreInstalledForThisServer();

          if (serverPreInstalled.includes(packageName)) {
            // Auto-add missing pre-installed app with current timestamp
            freshUser.installedApps.push({
              packageName,
              installedDate: new Date(),
              lastActiveAt: new Date(),
            });
            await freshUser.save();
            logger.info(
              `Auto-added missing pre-installed app ${packageName} for user ${freshUser.email}`,
            );
            return;
          }
          // If not pre-installed, silently ignore (app might be starting before installation completes)
          return;
        } catch (error) {
          {
            const err =
              error instanceof Error ? error : new Error(String(error));
            logger.error(
              err,
              "Error checking pre-installed apps in updateAppLastActive:",
            );
          }
          // Don't fail the operation if checking pre-installed apps fails
          return;
        }
      }
    } catch (error: any) {
      lastError = error;

      // If it's a version conflict, retry
      if (error.name === "VersionError") {
        logger.warn(
          `Version conflict in updateAppLastActive for user ${this.email}, app ${packageName}, attempt ${attempt + 1}/${maxRetries}`,
        );
        if (attempt < maxRetries - 1) {
          // Wait a bit before retrying (exponential backoff)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 50),
          );
          continue;
        }
      }

      // For other errors or max retries reached, throw
      throw error;
    }
  }

  // If we get here, all retries failed
  throw lastError;
};

// --- Glasses Model Methods ---
UserSchema.methods.addGlassesModel = async function (
  modelName: string,
): Promise<void> {
  if (!modelName || typeof modelName !== "string") {
    throw new Error("Model name must be a non-empty string");
  }

  // Sanitize the model name
  const sanitizedModelName = MongoSanitizer.sanitizeKey(modelName);

  // Check if model already exists
  if (!this.glassesModels) {
    this.glassesModels = [];
  }

  if (!this.glassesModels.includes(sanitizedModelName)) {
    this.glassesModels.push(sanitizedModelName);
    await this.save();
  }
};

UserSchema.methods.getGlassesModels = function (): string[] {
  return this.glassesModels || [];
};

// --- Middleware ---
UserSchema.pre("save", function (this: UserI, next) {
  if (this.email) {
    this.email = this.email.toLowerCase();
  }
  if (this.runningApps) {
    this.runningApps = [...new Set(this.runningApps)];
  }
  next();
});

// --- Static Methods ---
UserSchema.statics.findByEmail = async function (
  email: string,
): Promise<UserI | null> {
  return this.findOne({ email: email.toLowerCase() });
};

UserSchema.statics.findOrCreateUser = async function (
  email: string,
): Promise<UserI> {
  email = email.toLowerCase();
  let user = await this.findOne({ email });
  let isNewUser = false;

  if (!user) {
    try {
      user = await this.create({ email });
      await user.save();
      isNewUser = true;

      // Create personal organization for new user if they don't have one
      // Import OrganizationService to avoid circular dependency
      const {
        OrganizationService,
      } = require("../services/core/organization.service");

      // Check if the user already has organizations
      if (!user.organizations || user.organizations.length === 0) {
        const personalOrgId = await OrganizationService.createPersonalOrg(user);
        user.organizations = [personalOrgId];
        user.defaultOrg = personalOrgId;
        await user.save();
      }
    } catch (error) {
      console.error(error, "Error creating user");
      user = await this.findOne({ email });
      if (!user) {
        throw new Error("User not found after error creating user");
      }
    }
  }

  // Auto-install pre-installed apps for new users OR existing users missing them
  try {
    const {
      getPreInstalledForThisServer,
    } = require("../services/core/app.service");
    const serverPreInstalled = getPreInstalledForThisServer();

    const missingPreInstalled = serverPreInstalled.filter(
      (pkg: string) =>
        !user.installedApps?.some((app: any) => app.packageName === pkg),
    );

    if (missingPreInstalled.length > 0) {
      if (!user.installedApps) user.installedApps = [];

      for (const packageName of missingPreInstalled) {
        user.installedApps.push({
          packageName,
          installedDate: new Date(),
          // Don't set lastActiveAt initially
        });
      }
      await user.save();

      if (isNewUser) {
        logger.info(
          `Auto-installed ${missingPreInstalled.length} pre-installed apps for new user: ${email}`,
        );
      } else {
        logger.info(
          `Auto-installed ${missingPreInstalled.length} missing pre-installed apps for existing user: ${email}`,
        );
      }
    }
  } catch (error) {
    {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(err, "Error auto-installing pre-installed apps:");
    }
    // Don't fail user creation if app installation fails
  }

  // Auto-delete apps specified in DELETE_APP_BY_PACKAGE_NAME environment variable
  try {
    const deletePackageNames = process.env.DELETE_APP_BY_PACKAGE_NAME;

    if (deletePackageNames && deletePackageNames.trim()) {
      const packagesToDelete = deletePackageNames
        .split(",")
        .map((pkg) => pkg.trim())
        .filter((pkg) => pkg.length > 0);

      if (packagesToDelete.length > 0 && user.installedApps) {
        const deletedApps: string[] = [];

        // Filter out apps that should be deleted
        user.installedApps = user.installedApps.filter((app: any) => {
          const shouldDelete = packagesToDelete.includes(app.packageName);
          if (shouldDelete) {
            deletedApps.push(app.packageName);
          }
          return !shouldDelete;
        });

        // Only save if we actually deleted something
        if (deletedApps.length > 0) {
          await user.save();
          logger.info(
            {
              email,
              deletedApps,
              deletedCount: deletedApps.length,
            },
            `Auto-deleted ${deletedApps.length} app(s) for user: ${email}`,
          );
        }
      }
    }
  } catch (error) {
    {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(err, "Error auto-deleting apps:");
    }
    // Don't fail user creation if app deletion fails
  }

  return user;
};

UserSchema.statics.findUserInstalledApps = async function (
  email: string,
): Promise<any[]> {
  if (!email) {
    console.warn(
      "[User.findUserInstalledApps] Called with null or empty email",
    );
    return [];
  }

  try {
    const user = await this.findOne({ email: email.toLowerCase() });

    // Import app service to get full app details
    const App = mongoose.model("App");
    const { LOCAL_APPS, SYSTEM_AppS } = require("../services/core/app.service");

    // Get package names from installed apps (or empty array if no user or no installed apps)
    const userInstalledPackages =
      user?.installedApps?.map((app: any) => app.packageName) || [];

    // Create a map of package names to installation dates
    const installDates = new Map();
    if (user?.installedApps) {
      user.installedApps.forEach((app: any) => {
        installDates.set(app.packageName, app.installedDate);
      });
    }

    // Combine installed apps with full details
    const result = [];

    // Always include all system apps and LOCAL_APPS, regardless of whether they're installed
    const predefinedApps = [...LOCAL_APPS, ...SYSTEM_AppS];
    for (const app of predefinedApps) {
      // Use actual installation date if available, otherwise use current date
      const isInstalled = userInstalledPackages.includes(app.packageName);
      const installedDate = isInstalled
        ? installDates.get(app.packageName)
        : new Date(); // Default to current date for system apps

      // Add isSystemApp flag
      result.push({
        ...app,
        installedDate,
        isSystemApp: true,
      });
    }

    // Add user-installed apps from the database that aren't already in the list
    if (userInstalledPackages.length > 0) {
      // Filter out packages that are already in the result (system apps)
      const existingPackages = result.map((app: any) => app.packageName);
      const remainingPackages = userInstalledPackages.filter(
        (pkg: string) => !existingPackages.includes(pkg),
      );

      if (remainingPackages.length > 0) {
        // Then check database apps
        const dbApps = await App.find({
          packageName: { $in: remainingPackages },
        });
        for (const dbApp of dbApps) {
          // Only add if not already added from predefined apps
          if (!result.some((app) => app.packageName === dbApp.packageName)) {
            result.push({
              ...dbApp.toObject(),
              installedDate: installDates.get(dbApp.packageName),
            });
          }
        }

        // For any app we couldn't find details for, include at least the package name
        for (const packageName of remainingPackages) {
          if (!result.some((app) => app.packageName === packageName)) {
            result.push({
              packageName,
              name: packageName, // Use package name as fallback name
              installedDate: installDates.get(packageName),
            });
          }
        }
      }
    }

    return result;
  } catch (error) {
    console.error(
      error,
      `[User.findUserInstalledApps] Error finding apps for user ${email}:`,
    );
    // In case of error, return at least the system apps
    const { LOCAL_APPS, SYSTEM_AppS } = require("../services/core/app.service");
    return [...LOCAL_APPS, ...SYSTEM_AppS].map((app) => ({
      ...app,
      installedDate: new Date(),
      isSystemApp: true,
    }));
  }
};

/**
 * Creates a slug from a name
 * @private
 */

/**
 * Creates or ensures a personal organization for the user
 * @param user The user document
 * @returns The ObjectId of the personal organization
 */
UserSchema.statics.ensurePersonalOrg = async function (
  user: UserI,
): Promise<Types.ObjectId> {
  // Import Organization service to avoid circular dependency
  const {
    OrganizationService,
  } = require("../services/core/organization.service");

  if (user.defaultOrg) {
    // User already has a default org, return it
    return user.defaultOrg;
  }

  // Check if user has any organizations
  if (user.organizations && user.organizations.length > 0) {
    // User has organizations but no default, set the first one as default
    user.defaultOrg = user.organizations[0];
    await user.save();
    return user.defaultOrg;
  }

  // Create a personal organization for this user
  const personalOrgId = await OrganizationService.createPersonalOrg(user);

  // Update user object with the new org
  if (!user.organizations) {
    user.organizations = [];
  }

  // Add to organizations array if not already present
  if (
    !user.organizations.some(
      (orgId) => orgId.toString() === personalOrgId.toString(),
    )
  ) {
    user.organizations.push(personalOrgId);
  }

  // Set as default org
  user.defaultOrg = personalOrgId;

  // Save the updated user
  await user.save();

  return personalOrgId;
};

// --- Interface for Static Methods ---
interface UserModel extends Model<UserI> {
  findByEmail(email: string): Promise<UserI | null>;
  findOrCreateUser(email: string): Promise<UserI>;
  findUserInstalledApps(email: string): Promise<any[]>;
  ensurePersonalOrg(user: UserI): Promise<Types.ObjectId>;
}

export const User = (mongoose.models.User ||
  mongoose.model<UserI, UserModel>("User", UserSchema)) as UserModel;
