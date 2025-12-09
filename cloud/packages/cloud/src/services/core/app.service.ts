/**
 * @fileoverview Service for managing Apps (Third Party Applications).
 * Handles app lifecycle, authentication, and webhook interactions.
 *
 * Currently uses in-memory storage with hardcoded system Apps.
 * Design decision: Separate system Apps from user-created Apps
 * to maintain core functionality regardless of database state.
 */

import {
  StopWebhookRequest,
  WebhookResponse,
  ToolCall,
  WebhookRequestType,
  AppSetting,
  AppSettingType,
} from "@mentra/sdk";
// TODO(isaiah): Consider splitting this into multiple services (appstore.service, developer.service, tools.service)
import axios, { AxiosError } from "axios";
// import { systemApps } from './system-apps';
import App, { AppI } from "../../models/app.model";
import { ToolSchema, ToolParameterSchema } from "@mentra/sdk";
import { User } from "../../models/user.model";
import crypto from "crypto";
import { logger as rootLogger } from "../logging/pino-logger";
import { Types } from "mongoose";
const logger = rootLogger.child({ service: "app.service" });

const APPSTORE_ENABLED = true;
export const SYSTEM_DASHBOARD_PACKAGE_NAME =
  process.env.SYSTEM_DASHBOARD_PACKAGE_NAME || "dev.augmentos.dashboard";
export const PRE_INSTALLED = [
  "com.augmentos.livecaptions",
  "cloud.augmentos.notify",
  // "cloud.augmentos.mira",
];
export const PRE_INSTALLED_DEBUG = [
  // "com.mentra.link",
  // "com.mentra.notes",
  // "com.mentra.soundy",
  // "com.mentra.cactusai",
  // "com.mentra.hive",
  // "com.augmentos.calendarreminder",
  // "com.augmentos.xstats",
  // "com.augmentos.tictactoe",
  // "com.augmentos.displaytext",
  // "com.augmentos.shazam",
  // "cloud.augmentos.aughog",
  // "cloud.augmentos.recorder",
];

// export const PRE_INSTALLED = ["cloud.augmentos.live-captions-global", "cloud.augmentos.notify", "cloud.augmentos.mira"];

// Add debug apps in non-production environments
if (
  process.env.NODE_ENV !== "production" ||
  process.env.DEBUG_APPS === "true"
) {
  PRE_INSTALLED.push(...PRE_INSTALLED_DEBUG);
  logger.info(
    { PRE_INSTALLED_DEBUG },
    "Debug mode enabled - adding debug apps to preinstalled list:",
  );
}

// Add additional pre-installed apps from environment variable
if (process.env.ADDITIONAL_PRE_INSTALLED_APPS) {
  const additionalApps = process.env.ADDITIONAL_PRE_INSTALLED_APPS.split(",")
    .map((app) => app.trim())
    .filter((app) => app.length > 0);

  PRE_INSTALLED.push(...additionalApps);
  logger.info(
    { additionalApps },
    "Adding additional pre-installed apps from ADDITIONAL_PRE_INSTALLED_APPS:",
  );
}

// If we're in test mode, we don't want to pre-install any apps. (used with the headless client for testing)
if (process.env.NODE_ENV === "test") {
  logger.info("Test mode - no pre-installed apps");
  while (PRE_INSTALLED.length > 0) {
    PRE_INSTALLED.pop(); // Clear the pre-installed apps for testing
  }
}

/**
 * Returns the list of apps that should be auto-installed for users on this server instance.
 * This matches the environment - core apps only in production, core + debug in development.
 */
export function getPreInstalledForThisServer(): string[] {
  return [...PRE_INSTALLED]; // Return copy of current server's pre-installed apps
}

/**
 * System Apps that are always available.
 * These are core applications provided by the platform.
 * @Param developerId - leaving this undefined indicates a system app.
 */
export const LOCAL_APPS: AppI[] = [];

// String list of packageNames to preinstall / make uninstallable.

// Fetch from appstore and populate LOCAL_APPS.
(async function loadPreinstalledApps() {
  // Fetch all apps from the app store that are preinstalled.
  const preinstalledApps = (await App.find({
    packageName: { $in: PRE_INSTALLED },
  })) as AppI[];

  // Add them to the LOCAL_APPS array.
  preinstalledApps.forEach((app) => {
    app.uninstallable = true;
    LOCAL_APPS.push(app);
  });

  // Fetch dashboard app..
})();

export function isUninstallable(packageName: string) {
  return !PRE_INSTALLED.includes(packageName);
}

/**
 * Implementation of the app management service.
 * Design decisions:
 * 1. Separate system and user Apps
 * 2. Immutable system App list
 * 3. Webhook retry logic
 * 4. API key validation
 */
export class AppService {
  // In-memory cache for app states
  // Map of userId to Map of packageName to AppState

  /**
   * Gets all available Apps, both system and user-created.
   * @returns Promise resolving to array of all apps
   */
  async getAllApps(userId?: string): Promise<AppI[]> {
    let usersApps: AppI[] = [];

    if (APPSTORE_ENABLED && userId) {
      // Find apps the user installed.
      const user = await User.findOne({ email: userId });
      const _installedApps =
        user?.installedApps?.map(
          (installedApp: { packageName: string; installedDate: Date }) => {
            return installedApp.packageName;
          },
        ) || [];

      // Fetch the apps from the appstore.
      const _appstoreApps = (await App.find({
        packageName: { $in: _installedApps },
      })) as AppI[];

      // remove duplicates.
      const _allApps = _appstoreApps;
      const _appMap = new Map<string, AppI>();
      _allApps.forEach((app) => {
        _appMap.set(app.packageName, app);
      });

      usersApps.push(..._appMap.values());
      // Filter out any that are already in the LOCAL_APPS map since those would have already been fetched.
      usersApps = usersApps.filter(
        (app) =>
          !LOCAL_APPS.some(
            (localApp) => localApp.packageName === app.packageName,
          ),
      );
    }
    const allApps = [...LOCAL_APPS, ...usersApps];
    return allApps;
  }

  /**
   * Gets a specific App by ID.
   * @param packageName - App identifier
   * @returns Promise resolving to app if found
   */
  async getApp(packageName: string): Promise<AppI | undefined> {
    // Use lean() to get a plain JavaScript object instead of a Mongoose document
    const app = (await App.findOne({
      packageName: packageName,
    }).lean()) as AppI;
    return app;
  }

  /**
   * Triggers the stop webhook for a App app session.
   * @param url - Stop Webhook URL
   * @param payload - Data to send
   * @throws If stop webhook fails
   */
  async triggerStopWebhook(
    publicUrl: string,
    payload: StopWebhookRequest,
  ): Promise<{
    status: number;
    data: WebhookResponse;
  }> {
    // Construct the stop webhook URL from the app's public URL
    const webhookUrl = `${publicUrl}/webhook`;
    const response = await axios.post(webhookUrl, payload);
    return {
      status: response.status,
      data: response.data,
    };
  }

  // TODO(isaiah): Move this to the new AppManager within new UserSession class.
  async triggerStopByPackageName(
    packageName: string,
    userId: string,
  ): Promise<void> {
    // Look up the App by packageName
    const app = await this.getApp(packageName);
    const appSessionId = `${userId}-${packageName}`;

    const payload: StopWebhookRequest = {
      type: WebhookRequestType.STOP_REQUEST,
      sessionId: appSessionId,
      userId: userId,
      reason: "user_disabled",
      timestamp: new Date().toISOString(),
    };

    if (!app) {
      throw new Error(`App ${packageName} not found`);
    }

    if (!app.publicUrl) {
      throw new Error(`App ${packageName} does not have a public URL`);
    }

    await this.triggerStopWebhook(app.publicUrl, payload);
  }

  /**
   * Validates a App's API key.
   * @param packageName - App identifier
   * @param apiKey - API key to validate
   * @param clientIp - Optional IP address of the client for system app validation
   * @returns Promise resolving to validation result
   */
  async validateApiKey(packageName: string, apiKey: string): Promise<boolean> {
    const app = await this.getApp(packageName);
    if (!app) {
      logger.warn(`App ${packageName} not found`);
      return false;
    }

    // For regular apps, validate API key as normal
    // Get the MongoDB app document to access hashedApiKey
    const appDoc = await App.findOne({ packageName });

    if (!appDoc) {
      logger.warn(`App ${packageName} not found in database`);
      return false;
    }

    // Check if the app has a hashed API key
    // If the app is a system app, we don't need to validate the API key

    if (!appDoc?.hashedApiKey) {
      logger.warn(`App ${packageName} does not have a hashed API key`);
      return false;
    }

    // Hash the provided API key and compare with stored hash
    const hashedKey = this.hashApiKey(apiKey);

    logger.debug(
      `Validating API key for ${packageName}: ${hashedKey} === ${appDoc.hashedApiKey}`,
    );
    // Compare the hashed API key with the stored hashed API key

    return hashedKey === appDoc.hashedApiKey;
  }

  /**
   * Validates tool definitions against the schema requirements
   * @param tools Array of tool definitions to validate
   * @returns Validated and sanitized tools array or throws error if invalid
   */
  private validateToolDefinitions(tools: any[]): ToolSchema[] {
    logger.debug({ tools }, "Validating tool definitions:");
    if (!Array.isArray(tools)) {
      throw new Error("Tools must be an array");
    }

    return tools.map((tool) => {
      // Validate required fields
      if (!tool.id || typeof tool.id !== "string") {
        throw new Error("Tool id is required and must be a string");
      }

      if (!tool.description || typeof tool.description !== "string") {
        throw new Error("Tool description is required and must be a string");
      }

      // Activation phrases can be null or empty, no validation needed
      // We'll just ensure it's an array if provided
      if (tool.activationPhrases && !Array.isArray(tool.activationPhrases)) {
        throw new Error("Tool activationPhrases must be an array if provided");
      }

      // Validate parameters if they exist
      const validatedParameters: Record<string, ToolParameterSchema> = {};

      if (tool.parameters) {
        Object.entries(tool.parameters).forEach(
          ([key, param]: [string, any]) => {
            if (
              !param.type ||
              !["string", "number", "boolean"].includes(param.type)
            ) {
              throw new Error(
                `Parameter ${key} has invalid type. Must be string, number, or boolean`,
              );
            }

            if (!param.description || typeof param.description !== "string") {
              throw new Error(`Parameter ${key} requires a description`);
            }

            validatedParameters[key] = {
              type: param.type as "string" | "number" | "boolean",
              description: param.description,
              required: !!param.required,
            };

            // Add enum values if present
            if (param.enum && Array.isArray(param.enum)) {
              validatedParameters[key].enum = param.enum;
            }
          },
        );
      }

      return {
        id: tool.id,
        description: tool.description,
        activationPhrases: tool.activationPhrases.map((p: string) => p.trim()),
        parameters:
          Object.keys(validatedParameters).length > 0
            ? validatedParameters
            : undefined,
      };
    });
  }

  /**
   * Validates setting definitions against the schema requirements
   * @param settings Array of setting definitions to validate
   * @returns Validated and sanitized settings array or throws error if invalid
   */
  private validateSettingDefinitions(settings: any[]): AppSetting[] {
    logger.debug({ settings }, "Validating setting definitions:");
    if (!Array.isArray(settings)) {
      throw new Error("Settings must be an array");
    }

    return settings.map((setting) => {
      // Validate required type field
      if (!setting.type || typeof setting.type !== "string") {
        throw new Error("Setting type is required and must be a string");
      }

      // Group settings validation
      if (setting.type === "group") {
        if (!setting.title || typeof setting.title !== "string") {
          throw new Error("Group setting requires a title");
        }
        return {
          type: AppSettingType.GROUP,
          title: setting.title,
          key: "", // Groups don't need keys but BaseAppSetting requires it
          label: "", // Groups don't need labels but BaseAppSetting requires it
        } as AppSetting;
      }

      // Title/Value settings validation (display-only, no key required)
      if (setting.type === "titleValue") {
        if (!setting.label || typeof setting.label !== "string") {
          throw new Error("Title/Value setting requires a label");
        }
        return {
          type: "titleValue" as any,
          label: setting.label,
          value: setting.value || "",
        } as AppSetting;
      }

      // Regular settings validation (require key and label)
      if (!setting.key || typeof setting.key !== "string") {
        throw new Error("Setting key is required and must be a string");
      }

      if (!setting.label || typeof setting.label !== "string") {
        throw new Error("Setting label is required and must be a string");
      }

      // Type-specific validation
      switch (setting.type) {
        case "toggle":
          if (
            setting.defaultValue !== undefined &&
            typeof setting.defaultValue !== "boolean"
          ) {
            throw new Error("Toggle setting requires a boolean defaultValue");
          }
          return {
            type: AppSettingType.TOGGLE,
            key: setting.key,
            label: setting.label,
            defaultValue:
              setting.defaultValue !== undefined ? setting.defaultValue : false,
            value: setting.value,
          } as AppSetting;

        case "text":
          return {
            type: AppSettingType.TEXT,
            key: setting.key,
            label: setting.label,
            defaultValue: setting.defaultValue || "",
            value: setting.value,
          } as AppSetting;

        case "text_no_save_button":
          return {
            type: "text_no_save_button" as any,
            key: setting.key,
            label: setting.label,
            defaultValue: setting.defaultValue || "",
            value: setting.value,
            maxLines: setting.maxLines,
          } as AppSetting;

        case "select":
          if (!Array.isArray(setting.options)) {
            throw new Error("Select setting requires an options array");
          }
          if (
            !setting.options.every(
              (opt: any) => typeof opt.label === "string" && "value" in opt,
            )
          ) {
            throw new Error(
              "Select options must have label and value properties",
            );
          }
          return {
            type: AppSettingType.SELECT,
            key: setting.key,
            label: setting.label,
            options: setting.options,
            defaultValue: setting.defaultValue,
            value: setting.value,
          } as AppSetting;

        case "select_with_search":
          if (!Array.isArray(setting.options)) {
            throw new Error(
              "Select with search setting requires an options array",
            );
          }
          if (
            !setting.options.every(
              (opt: any) => typeof opt.label === "string" && "value" in opt,
            )
          ) {
            throw new Error(
              "Select with search options must have label and value properties",
            );
          }
          return {
            type: "select_with_search" as any,
            key: setting.key,
            label: setting.label,
            options: setting.options,
            defaultValue: setting.defaultValue,
            value: setting.value,
          } as AppSetting;

        case "multiselect":
          if (!Array.isArray(setting.options)) {
            throw new Error("Multiselect setting requires an options array");
          }
          if (
            !setting.options.every(
              (opt: any) => typeof opt.label === "string" && "value" in opt,
            )
          ) {
            throw new Error(
              "Multiselect options must have label and value properties",
            );
          }
          // Ensure defaultValue is an array for multiselect
          const defaultValue = Array.isArray(setting.defaultValue)
            ? setting.defaultValue
            : [];
          const value = Array.isArray(setting.value)
            ? setting.value
            : undefined;
          return {
            type: "multiselect" as any,
            key: setting.key,
            label: setting.label,
            options: setting.options,
            defaultValue: defaultValue,
            value: value,
          } as AppSetting;

        case "slider":
          if (
            typeof setting.min !== "number" ||
            typeof setting.max !== "number"
          ) {
            throw new Error(
              "Slider setting requires numeric min and max values",
            );
          }
          if (
            setting.defaultValue !== undefined &&
            typeof setting.defaultValue !== "number"
          ) {
            throw new Error("Slider setting requires a numeric defaultValue");
          }
          if (setting.min > setting.max) {
            throw new Error(
              "Slider min value cannot be greater than max value",
            );
          }
          return {
            type: AppSettingType.SLIDER,
            key: setting.key,
            label: setting.label,
            min: setting.min,
            max: setting.max,
            defaultValue:
              setting.defaultValue !== undefined
                ? setting.defaultValue
                : setting.min,
            value: setting.value,
          } as AppSetting;

        case "numeric_input":
          // Validate optional numeric fields
          if (setting.min !== undefined && typeof setting.min !== "number") {
            throw new Error("Numeric input min value must be a number");
          }
          if (setting.max !== undefined && typeof setting.max !== "number") {
            throw new Error("Numeric input max value must be a number");
          }
          if (setting.step !== undefined && typeof setting.step !== "number") {
            throw new Error("Numeric input step value must be a number");
          }
          if (
            setting.placeholder !== undefined &&
            typeof setting.placeholder !== "string"
          ) {
            throw new Error("Numeric input placeholder must be a string");
          }
          if (
            setting.defaultValue !== undefined &&
            typeof setting.defaultValue !== "number"
          ) {
            throw new Error("Numeric input defaultValue must be a number");
          }
          return {
            type: "numeric_input" as any,
            key: setting.key,
            label: setting.label,
            min: setting.min,
            max: setting.max,
            step: setting.step,
            placeholder: setting.placeholder,
            defaultValue:
              setting.defaultValue !== undefined ? setting.defaultValue : 0,
            value: setting.value,
          } as AppSetting;

        case "time_picker":
          if (
            setting.showSeconds !== undefined &&
            typeof setting.showSeconds !== "boolean"
          ) {
            throw new Error("Time picker showSeconds must be a boolean");
          }
          if (
            setting.defaultValue !== undefined &&
            typeof setting.defaultValue !== "number"
          ) {
            throw new Error(
              "Time picker defaultValue must be a number (total seconds)",
            );
          }
          return {
            type: "time_picker" as any,
            key: setting.key,
            label: setting.label,
            showSeconds:
              setting.showSeconds !== undefined ? setting.showSeconds : true,
            defaultValue:
              setting.defaultValue !== undefined ? setting.defaultValue : 0,
            value: setting.value,
          } as AppSetting;

        default:
          throw new Error(`Unsupported setting type: ${setting.type}`);
      }
    });
  }

  /**
   * Create a new app
   */
  async createApp(
    appData: any,
    developerId: string,
  ): Promise<{ app: AppI; apiKey: string }> {
    // Generate API key
    const apiKey = crypto.randomBytes(32).toString("hex");
    const hashedApiKey = this.hashApiKey(apiKey);

    // Parse and validate tools if present
    if (appData.tools) {
      try {
        appData.tools = this.validateToolDefinitions(appData.tools);
      } catch (error: any) {
        throw new Error(`Invalid tool definitions: ${error.message}`);
      }
    }

    // Parse and validate settings if present
    if (appData.settings) {
      try {
        appData.settings = this.validateSettingDefinitions(appData.settings);
      } catch (error: any) {
        throw new Error(`Invalid setting definitions: ${error.message}`);
      }
    }

    // Create app with organization ownership
    const app = await App.create({
      ...appData,
      developerId, // Keep for backward compatibility during migration
      hashedApiKey,
    });

    return { app, apiKey };
  }

  // TODO(isaiah): Move this to the new developer service to declutter the app service.
  /**
   * Update an app
   */
  async updateApp(
    packageName: string,
    appData: any,
    developerId: string,
    organizationId?: Types.ObjectId,
  ): Promise<AppI> {
    // Ensure organization owns the app
    const app = await App.findOne({ packageName });
    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }
    if (!developerId) {
      throw new Error("Developer ID is required");
    }

    // Check if user has permission to update the app
    let hasPermission = false;

    // If organization ID is provided, check ownership
    if (organizationId && app.organizationId) {
      hasPermission =
        app.organizationId.toString() === organizationId.toString();
    }
    // For backward compatibility, check developer ID
    else if (app.developerId) {
      hasPermission = app.developerId.toString() === developerId;
    }

    if (!hasPermission) {
      throw new Error("You do not have permission to update this app");
    }

    // Parse and validate tools if present
    if (appData.tools) {
      try {
        appData.tools = this.validateToolDefinitions(appData.tools);
      } catch (error: any) {
        throw new Error(`Invalid tool definitions: ${error.message}`);
      }
    }

    // Parse and validate settings if present
    if (appData.settings) {
      try {
        appData.settings = this.validateSettingDefinitions(appData.settings);
      } catch (error: any) {
        throw new Error(`Invalid setting definitions: ${error.message}`);
      }
    }

    // If developerInfo is provided, ensure it's properly structured
    if (appData.developerInfo) {
      // Make sure only valid fields are included
      const validFields = ["company", "website", "contactEmail", "description"];
      const sanitizedDeveloperInfo: any = {};

      for (const field of validFields) {
        if (appData.developerInfo[field] !== undefined) {
          sanitizedDeveloperInfo[field] = appData.developerInfo[field];
        }
      }

      // Replace with sanitized version
      appData.developerInfo = sanitizedDeveloperInfo;
    }

    // Update app
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: appData },
      { new: true },
    );

    return updatedApp!;
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  /**
   * Publish an app to the app store
   */
  async publishApp(
    packageName: string,
    developerId: string,
    organizationId?: Types.ObjectId,
  ): Promise<AppI> {
    // Ensure organization owns the app
    const app = await App.findOne({ packageName });
    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }
    if (!developerId) {
      throw new Error("Developer ID is required");
    }

    // Check if user has permission to publish the app
    let hasPermission = false;

    // If organization ID is provided, check ownership
    if (organizationId && app.organizationId) {
      hasPermission =
        app.organizationId.toString() === organizationId.toString();
    }
    // For backward compatibility, check developer ID
    else if (app.developerId) {
      hasPermission = app.developerId.toString() === developerId;
    }

    if (!hasPermission) {
      throw new Error("You do not have permission to publish this app");
    }

    // If the app belongs to an organization, verify organization profile completeness
    if (organizationId) {
      const Organization =
        require("../../models/organization.model").Organization;
      const org = await Organization.findById(organizationId);

      if (!org) {
        throw new Error("Organization not found");
      }

      // Check if organization profile has the required fields
      if (!org.profile?.contactEmail) {
        throw new Error(
          "PROFILE_INCOMPLETE: Organization profile is incomplete. Please add a contact email before publishing an app.",
        );
      }
    }
    // For backward compatibility - check developer profile
    else {
      // Verify that the developer has filled out the required profile information
      const developer = await User.findOne({ email: developerId });
      if (!developer) {
        throw new Error("Developer not found");
      }

      // Check if developer profile has the required fields
      if (!developer.profile?.company || !developer.profile?.contactEmail) {
        throw new Error(
          "PROFILE_INCOMPLETE: Developer profile is incomplete. Please fill out your company name and contact email before publishing an app.",
        );
      }
    }

    // Update app status to SUBMITTED
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: { appStoreStatus: "SUBMITTED" } },
      { new: true },
    );

    return updatedApp!;
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  /**
   * Delete an app
   */
  async deleteApp(
    packageName: string,
    developerId: string,
    organizationId?: Types.ObjectId,
  ): Promise<void> {
    // Ensure organization owns the app
    const app = await App.findOne({ packageName });
    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }
    if (!developerId) {
      throw new Error("Developer ID is required");
    }

    // Check if user has permission to delete the app
    let hasPermission = false;

    // If organization ID is provided, check ownership
    if (organizationId && app.organizationId) {
      hasPermission =
        app.organizationId.toString() === organizationId.toString();
    }
    // For backward compatibility, check developer ID
    else if (app.developerId) {
      hasPermission = app.developerId.toString() === developerId;
    }

    if (!hasPermission) {
      throw new Error("You do not have permission to delete this app");
    }
    await App.findOneAndDelete({ packageName });
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  /**
   * Regenerate API key for an app
   */
  async regenerateApiKey(
    packageName: string,
    developerId: string,
    organizationId?: Types.ObjectId,
  ): Promise<string> {
    // Ensure organization owns the app
    const app = await App.findOne({ packageName });
    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }
    if (!developerId) {
      throw new Error("Developer ID is required");
    }

    // Check if user has permission to update the app
    let hasPermission = false;

    // If organization ID is provided, check ownership
    if (organizationId && app.organizationId) {
      hasPermission =
        app.organizationId.toString() === organizationId.toString();
    }
    // For backward compatibility, check developer ID
    else if (app.developerId) {
      hasPermission = app.developerId.toString() === developerId;
    }

    if (!hasPermission) {
      throw new Error("You do not have permission to update this app");
    }

    // Generate new API key
    const apiKey = crypto.randomBytes(32).toString("hex");
    const hashedApiKey = this.hashApiKey(apiKey);

    // Update app with new hashed API key
    await App.findOneAndUpdate({ packageName }, { $set: { hashedApiKey } });

    return apiKey;
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  /**
   * Hash API key
   */
  hashApiKey(apiKey: string): string {
    return crypto.createHash("sha256").update(apiKey).digest("hex");
  }

  /**
   * Hash a string using an app's hashed API key
   * @param stringToHash - String to be hashed
   * @param packageName - Package name of the app to use its hashed API key
   * @returns Promise resolving to the resulting hash string
   */
  async hashWithApiKey(
    stringToHash: string,
    packageName: string,
  ): Promise<string> {
    const app = await App.findOne({ packageName });

    if (!app || !app.hashedApiKey) {
      throw new Error(`App ${packageName} not found or has no API key`);
    }

    // Create a hash using the provided string and the app's hashed API key
    return crypto
      .createHash("sha256")
      .update(stringToHash)
      .update(app.hashedApiKey)
      .digest("hex");
  }

  /**
   * Get app by package name
   */
  async getAppByPackageName(
    packageName: string,
    developerId?: string,
    organizationId?: Types.ObjectId,
  ): Promise<AppI | null> {
    const query: any = { packageName };

    // If organizationId is provided, ensure the app belongs to this organization
    if (organizationId) {
      query.organizationId = organizationId;
    }
    // For backward compatibility, if only developerId is provided
    else if (developerId) {
      query.developerId = developerId;
    }

    // Use lean() to get a plain JavaScript object instead of a Mongoose document
    return App.findOne(query).lean();
  }

  /**
   * Get all available apps for the app store
   * Only returns apps with PUBLISHED status
   */
  async getAvailableApps(): Promise<AppI[]> {
    return App.find({ appStoreStatus: "PUBLISHED" });
  }

  /**
   * Triggers the App tool webhook for Mira AI integration
   * @param packageName - The package name of the App to send the tool to
   * @param payload - The tool webhook payload containing tool details
   * @returns Promise resolving to the webhook response or error
   */
  async triggerAppToolWebhook(
    packageName: string,
    payload: ToolCall,
  ): Promise<{
    status: number;
    data: any;
  }> {
    // Look up the App by packageName
    const app = await this.getApp(packageName);

    logger.debug({ packageName }, "🔨 Triggering tool webhook for:");

    if (!app) {
      throw new Error(`App ${packageName} not found`);
    }

    if (!app.publicUrl) {
      throw new Error(`App ${packageName} does not have a public URL`);
    }

    // Get the app document from MongoDB
    const appDoc = await App.findOne({ packageName });
    if (!appDoc) {
      throw new Error(`App ${packageName} not found in database`);
    }

    // For security reasons, we can't retrieve the original API key
    // Instead, we'll use a special header that identifies this as a system request
    // The App server will need to validate this using the hashedApiKey

    // Construct the webhook URL from the app's public URL
    const webhookUrl = `${app.publicUrl}/tool`;

    // Set up retry configuration
    const maxRetries = 2;
    const baseDelay = 1000; // 1 second

    logger.debug({ webhookUrl }, "🔨 Sending tool webhook to:");
    logger.debug({ payload }, "🔨 Payload:");

    // Attempt to send the webhook with retries
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await axios.post(webhookUrl, payload, {
          headers: {
            "Content-Type": "application/json",
            "X-App-API-Key": appDoc.hashedApiKey, // Use the hashed API key for authentication
          },
          timeout: 20000, // 10 second timeout
        });

        // Return successful response
        return {
          status: response.status,
          data: response.data,
        };
      } catch (error: unknown) {
        // If this is the last retry attempt, throw an error
        if (attempt === maxRetries - 1) {
          if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError;
            logger.error(
              axiosError as Error,
              `Tool webhook failed for ${packageName}: ${axiosError.message}`,
            );

            // Return a standardized error response
            return {
              status: axiosError.response?.status || 500,
              data: {
                error: true,
                message: `Webhook failed: ${axiosError.message}`,
                details: axiosError.response?.data || {},
              },
            };
          } else {
            // Handle non-Axios errors
            const genericError = error as Error;
            return {
              status: 500,
              data: {
                error: true,
                message: `Webhook failed: ${
                  genericError.message || "Unknown error"
                }`,
              },
            };
          }
        }

        // Exponential backoff before retry
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelay * Math.pow(2, attempt)),
        );
      }
    }

    // This should never be reached due to the error handling above,
    // but TypeScript requires a return value
    return {
      status: 500,
      data: {
        error: true,
        message: "Unknown error occurred",
      },
    };
  }

  /**
   * Gets all tool definitions for a App
   * Used by Mira AI to discover available tools
   * @param packageName - The package name of the App
   * @returns Array of tool definitions
   */
  async getAppTools(packageName: string): Promise<ToolSchema[]> {
    // Look up the App by packageName
    const app = await this.getApp(packageName);

    if (!app) {
      throw new Error(`App ${packageName} not found`);
    }

    logger.debug({ packageName }, "Getting App tools for:");

    // Get tools from the database instead of fetching app_config.json
    if (app.tools && Array.isArray(app.tools)) {
      logger.debug(
        `Found ${app.tools.length} tools in ${packageName} database`,
      );
      return app.tools;
    }

    // If no tools found in database, return empty array
    logger.debug(`No tools found in database for app ${packageName}`);
    return [];
  }

  // Add a method to update app visibility
  async updateAppVisibility(
    packageName: string,
    developerId: string,
    sharedWithOrganization: boolean,
  ): Promise<AppI> {
    // Ensure developer owns the app
    const app = await App.findOne({ packageName });
    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }
    if (
      !developerId ||
      !app.developerId ||
      app.developerId.toString() !== developerId
    ) {
      throw new Error("You do not have permission to update this app");
    }
    let organizationDomain = null;
    let visibility: "private" | "organization" = "private";
    if (sharedWithOrganization) {
      const emailParts = developerId.split("@");
      if (emailParts.length === 2) {
        organizationDomain = emailParts[1].toLowerCase();
        visibility = "organization";
      }
    }
    app.sharedWithOrganization = sharedWithOrganization;
    app.organizationDomain = organizationDomain;
    app.visibility = visibility;
    await app.save();
    return app;
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  async updateSharedWithEmails(
    packageName: string,
    emails: string[],
    developerId: string,
  ): Promise<AppI> {
    // Ensure developer owns the app or is in the org if shared
    const app = await App.findOne({ packageName });
    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }
    if (!developerId) {
      throw new Error("Developer ID is required");
    }
    const isOwner =
      app.developerId && app.developerId.toString() === developerId;
    let isOrgMember = false;
    if (app.sharedWithOrganization && app.organizationDomain) {
      const emailDomain = developerId.split("@")[1]?.toLowerCase();
      isOrgMember = emailDomain === app.organizationDomain;
    }
    if (!isOwner && !isOrgMember) {
      throw new Error("Not authorized to update sharing list");
    }
    // Validate emails (basic)
    const validEmails = emails.filter((email) =>
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email),
    );
    app.sharedWithEmails = validEmails;
    await app.save();
    return app.toObject();
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  /**
   * Get apps by organization ID
   */
  async getAppsByOrgId(orgId: Types.ObjectId): Promise<AppI[]> {
    return App.find({ organizationId: orgId }).lean();
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  // Replace getAppsByDeveloperId with getAppsByOrgId, but keep for backward compatibility
  async getAppsByDeveloperId(developerId: string): Promise<AppI[]> {
    return App.find({ developerId }).lean();
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  /**
   * Get apps created by or shared with a user (deduplicated)
   */
  async getAppsCreatedOrSharedWith(email: string): Promise<AppI[]> {
    // Now just returns apps by developer ID for backward compatibility
    return this.getAppsByDeveloperId(email);
  }

  // TODO(isaiah): Move this logic to a new developer service to declutter the app service.
  /**
   * Move an app from one organization to another
   * @param packageName - The package name of the app to move
   * @param sourceOrgId - The ID of the source organization
   * @param targetOrgId - The ID of the target organization
   * @param userEmail - The email of the user performing the action
   * @returns The updated app
   * @throws Error if app not found or user doesn't have permission
   */
  async moveApp(
    packageName: string,
    sourceOrgId: Types.ObjectId,
    targetOrgId: Types.ObjectId,
    userEmail: string,
  ): Promise<AppI> {
    // Find the app in the source organization
    const app = await App.findOne({
      packageName,
      organizationId: sourceOrgId,
    });

    if (!app) {
      throw new Error(
        `App with package name ${packageName} not found in source organization`,
      );
    }

    // Update organization ID
    app.organizationId = targetOrgId;
    await app.save();

    // Log the move operation
    logger.info(
      {
        packageName,
        sourceOrgId: sourceOrgId.toString(),
        targetOrgId: targetOrgId.toString(),
        userEmail,
      },
      "App moved to new organization",
    );

    return app;
  }
}

// Create singleton instance
export const appService = new AppService();
logger.info("✅ App Service initialized");

export default appService;
