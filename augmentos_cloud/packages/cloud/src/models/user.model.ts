// cloud/src/models/user.model.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { AppSettingType, type AppSetting } from '@augmentos/sdk';
import { MongoSanitizer } from '../utils/mongoSanitizer';
import { logger } from '@augmentos/utils';

interface Location {
  lat: number;
  lng: number;
}

interface InstalledApp {
  packageName: string;
  installedDate: Date;
}

// Extend Document for TypeScript support
interface UserDocument extends Document {
  email: string;
  runningApps: string[];
  appSettings: Map<string, AppSetting[]>;
  augmentosSettings: {
    useOnboardMic: boolean;
    contextualDashboard: boolean;
    headUpAngle: number;
    brightness: number;
    autoBrightness: boolean;
    sensingEnabled: boolean;
    alwaysOnStatusBar: boolean;
    bypassVad: boolean;
    bypassAudioEncoding: boolean;
    metricSystemEnabled: boolean;
  };
  location?: Location;
  installedApps?: Array<{
    packageName: string;
    installedDate: Date;
  }>;
  profile?: {
    company?: string;
    website?: string;
    contactEmail?: string;
    description?: string;
    logo?: string;
  };

  setLocation(location: Location): Promise<void>;
  addRunningApp(appName: string): Promise<void>;
  removeRunningApp(appName: string): Promise<void>;
  updateAppSettings(appName: string, settings: { key: string; value: any }[]): Promise<void>;
  // getAppSettings(appName: string): AppSetting[] | undefined;
  getAppSettings(appName: string): any[] | undefined;
  isAppRunning(appName: string): boolean;

  // New methods for installed apps
  installApp(packageName: string): Promise<void>;
  uninstallApp(packageName: string): Promise<void>;
  isAppInstalled(packageName: string): boolean;

  updateAugmentosSettings(settings: Partial<UserDocument['augmentosSettings']>): Promise<void>;
  getAugmentosSettings(): UserDocument['augmentosSettings'];
}

const InstalledAppSchema = new Schema({
  packageName: { type: String, required: true },
  installedDate: { type: Date, default: Date.now }
});

// --- New Schema for Lightweight Updates ---
const AppSettingUpdateSchema = new Schema({
  key: { type: String, required: true },
  value: { type: Schema.Types.Mixed, required: true }
}, { _id: false });

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
const UserSchema = new Schema<UserDocument>({
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
      message: 'Invalid email format'
    }
  },
  augmentosSettings: {
    type: {
      useOnboardMic: { type: Boolean, default: false },
      contextualDashboard: { type: Boolean, default: true },
      metricSystemEnabled: { type: Boolean, default: false },
      headUpAngle: { type: Number, default: 20 },
      brightness: { type: Number, default: 50 },
      autoBrightness: { type: Boolean, default: false },
      sensingEnabled: { type: Boolean, default: true },
      alwaysOnStatusBar: { type: Boolean, default: false },
      bypassVad: { type: Boolean, default: false },
      bypassAudioEncoding: { type: Boolean, default: false },
    },
    default: function() {
      return {
        useOnboardMic: false,
        contextualDashboard: true,
        metricSystemEnabled: false,
        headUpAngle: 20,
        brightness: 50,
        autoBrightness: false,
        sensingEnabled: true,
        alwaysOnStatusBar: false,
        bypassVad: false,
        bypassAudioEncoding: false,
      };
    }
  },
  // Cache location so timezones can be calculated by dashboard manager immediately.
  location: {
    type: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true }
    }
  },
  
  profile: {
    company: { type: String, required: false }, // Not required in schema, but validated in app publish flow
    website: { type: String },
    contactEmail: { type: String, required: false }, // Not required in schema, but validated in app publish flow
    description: { type: String },
    logo: { type: String }
  },

  runningApps: {
    type: [String],
    default: [],
    validate: {
      validator: function(apps: string[]) {
        return new Set(apps).size === apps.length;
      },
      message: 'Running apps must be unique'
    }
  },
  appSettings: {
    type: Map,
    of: [AppSettingUpdateSchema], // Use the new schema for updates
    default: new Map()
  },

  installedApps: {
    type: [InstalledAppSchema],
    default: [],
    validate: {
      validator: function(apps: InstalledApp[]) {
        // Ensure no duplicate package names
        const packageNames = apps.map(app => app.packageName);
        return new Set(packageNames).size === packageNames.length;
      },
      message: 'Installed apps must be unique'
    }
  }
}, {
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
    }
  }
});

// // Add discriminators
// AppSettingUpdateSchema.discriminator('toggle', ToggleSettingSchema);
// AppSettingUpdateSchema.discriminator('text', TextSettingSchema);
// AppSettingUpdateSchema.discriminator('select', SelectSettingSchema);

// Create compound index for unique running apps per user
UserSchema.index({ email: 1, 'runningApps': 1 }, { unique: true });

// Instance methods

// Install / uninstall.
// Add methods for managing installed apps
UserSchema.methods.installApp = async function (this: UserDocument, packageName: string): Promise<void> {
  if (!this.isAppInstalled(packageName)) {
    if (!this.installedApps) {
      this.installedApps = [];
    }
    this.installedApps.push({
      packageName,
      installedDate: new Date()
    });
    await this.save();
  }
};

UserSchema.methods.uninstallApp = async function (this: UserDocument, packageName: string): Promise<void> {
  if (this.isAppInstalled(packageName)) {
    if (!this.installedApps) {
      this.installedApps = [];
    }
    this.installedApps = this.installedApps.filter(app => app.packageName !== packageName);
    await this.save();
  }
};

UserSchema.methods.isAppInstalled = function(this: UserDocument, packageName: string): boolean {
  return this.installedApps?.some(app => app.packageName === packageName) ?? false;
}

// Update location.
UserSchema.methods.setLocation = async function (this: UserDocument, location: Location): Promise<void> {
  this.location = location;
  await this.save();
}

UserSchema.methods.addRunningApp = async function (this: UserDocument, appName: string): Promise<void> {
  if (!this.runningApps.includes(appName)) {
    this.runningApps.push(appName);
    await this.save();
  }
};

UserSchema.methods.removeRunningApp = async function (this: UserDocument, appName: string): Promise<void> {
  if (this.runningApps.includes(appName)) {
    this.runningApps = this.runningApps.filter(app => app !== appName);
    await this.save();
  }
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


UserSchema.methods.updateAppSettings = async function(
  appName: string, 
  settings: { key: string; value: any }[]
): Promise<void> {
  console.log('Settings update payload (before saving):', JSON.stringify(settings));

  // Sanitize the appName since it's used as a Map key
  const sanitizedAppName = MongoSanitizer.sanitizeKey(appName);

  console.log('App name:', sanitizedAppName);

  // Retrieve existing settings and convert subdocuments to plain objects.
  const existingSettings = this.appSettings.get(sanitizedAppName);
  let existingSettingsPlain: { key: string; value: any }[] = [];
  if (existingSettings && Array.isArray(existingSettings)) {
    existingSettingsPlain = existingSettings.map((s: any) =>
      typeof s.toObject === 'function' ? s.toObject() : s
    );
  }

  // Create a map from the existing settings.
  const existingSettingsMap = new Map(existingSettingsPlain.map(s => [s.key, s.value]));

  // Merge updates from the payload.
  settings.forEach(update => {
    if (update.key !== undefined) { // extra guard to prevent undefined keys
      existingSettingsMap.set(update.key, update.value);
    }
  });

  // Convert the merged map back into an array of settings.
  const updatedSettingsArray = Array.from(existingSettingsMap.entries()).map(
    ([key, value]) => ({ key, value })
  );

  // Use the merged settings array instead of just the new settings
  this.appSettings.set(sanitizedAppName, updatedSettingsArray);
  await this.save();

  console.log('Updated settings:', JSON.stringify(updatedSettingsArray));
  const afterUpdate = this.appSettings.get(sanitizedAppName);
  console.log('Settings retrieved after save:', JSON.stringify(afterUpdate));

  return afterUpdate;
};

UserSchema.methods.getAppSettings = function (this: UserDocument, appName: string): AppSetting[] | undefined {
  const sanitizedAppName = MongoSanitizer.sanitizeKey(appName);
  const settings = this.appSettings.get(sanitizedAppName);
  return settings;
};

UserSchema.methods.isAppRunning = function (this: UserDocument, appName: string): boolean {
  return this.runningApps.includes(appName);
};

UserSchema.methods.updateAugmentosSettings = async function(
  this: UserDocument,
  settings: Partial<UserDocument['augmentosSettings']>
): Promise<void> {
  // Convert to plain objects for clean logging
  const currentSettingsClean = JSON.parse(JSON.stringify(this.augmentosSettings));
  const newSettingsClean = JSON.parse(JSON.stringify(settings));
  
  logger.info('Updating AugmentOS settings:', {
    userId: this.email,
    currentSettings: currentSettingsClean,
    newSettings: newSettingsClean
  });

  // Directly apply each setting to ensure updates happen properly
  Object.entries(settings).forEach(([key, value]) => {
    if (value !== undefined) {
      // @ts-ignore - We're dynamically updating the settings
      this.augmentosSettings[key] = value;
    }
  });

  // Convert to plain object for clean logging
  const mergedSettingsClean = JSON.parse(JSON.stringify(this.augmentosSettings));
  logger.info('Merged settings:', mergedSettingsClean);
  
  await this.save();
  logger.info('Settings saved successfully');
};

UserSchema.methods.getAugmentosSettings = function(
  this: UserDocument
): UserDocument['augmentosSettings'] {
  return this.augmentosSettings;
};

// --- Static Methods ---
UserSchema.statics.findByEmail = async function(email: string): Promise<UserDocument | null> {
  return this.findOne({ email: email.toLowerCase() });
};

UserSchema.statics.findOrCreateUser = async function (email: string): Promise<UserDocument> {
  email = email.toLowerCase();
  let user = await this.findOne({ email });
  if (!user) {
    user = await this.create({ email });
  }
  return user;
};

UserSchema.statics.findUserInstalledApps = async function (email: string): Promise<any[]> {
  if (!email) {
    console.warn('[User.findUserInstalledApps] Called with null or empty email');
    return [];
  }
  
  try {
    const user = await this.findOne({ email: email.toLowerCase() });
    
    // Import app service to get full app details
    const App = mongoose.model('App');
    const { LOCAL_APPS, SYSTEM_TPAS } = require('../services/core/app.service');
    
    // Get package names from installed apps (or empty array if no user or no installed apps)
    const userInstalledPackages = user?.installedApps?.map((app: any) => app.packageName) || [];
    
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
    const predefinedApps = [...LOCAL_APPS, ...SYSTEM_TPAS];
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
        isSystemApp: true
      });
    }
    
    // Add user-installed apps from the database that aren't already in the list
    if (userInstalledPackages.length > 0) {
      // Filter out packages that are already in the result (system apps)
      const existingPackages = result.map((app: any) => app.packageName);
      const remainingPackages = userInstalledPackages.filter((pkg: string) => !existingPackages.includes(pkg));
      
      if (remainingPackages.length > 0) {
        // Then check database apps
        const dbApps = await App.find({ packageName: { $in: remainingPackages } });
        for (const dbApp of dbApps) {
          // Only add if not already added from predefined apps
          if (!result.some(app => app.packageName === dbApp.packageName)) {
            result.push({
              ...dbApp.toObject(),
              installedDate: installDates.get(dbApp.packageName)
            });
          }
        }
        
        // For any app we couldn't find details for, include at least the package name
        for (const packageName of remainingPackages) {
          if (!result.some(app => app.packageName === packageName)) {
            result.push({
              packageName,
              name: packageName, // Use package name as fallback name
              installedDate: installDates.get(packageName)
            });
          }
        }
      }
    }
    
    return result;
  } catch (error) {
    console.error(`[User.findUserInstalledApps] Error finding apps for user ${email}:`, error);
    // In case of error, return at least the system apps
    const { LOCAL_APPS, SYSTEM_TPAS } = require('../services/core/app.service');
    return [...LOCAL_APPS, ...SYSTEM_TPAS].map(app => ({
      ...app,
      installedDate: new Date(),
      isSystemApp: true
    }));
  }
};

// --- Middleware ---
UserSchema.pre('save', function(next) {
  if (this.email) {
    this.email = this.email.toLowerCase();
  }
  if (this.runningApps) {
    this.runningApps = [...new Set(this.runningApps)];
  }
  next();
});

// --- Interface for Static Methods ---
interface UserModel extends Model<UserDocument> {
  findByEmail(email: string): Promise<UserDocument | null>;
  findOrCreateUser(email: string): Promise<UserDocument>;
  findUserInstalledApps(email: string): Promise<any[]>;
}

export const User = mongoose.model<UserDocument, UserModel>('User', UserSchema);
