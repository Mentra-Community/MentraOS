/**
 * @fileoverview Service for managing TPAs (Third Party Applications).
 * Handles app lifecycle, authentication, and webhook interactions.
 * 
 * Currently uses in-memory storage with hardcoded system TPAs.
 * Design decision: Separate system TPAs from user-created TPAs
 * to maintain core functionality regardless of database state.
 */

import { AppI, StopWebhookRequest, TpaType, WebhookResponse, AppState, SessionWebhookRequest, ToolCall } from '@augmentos/sdk';
import axios, { AxiosError } from 'axios';
import { systemApps } from './system-apps';
import App from '../../models/app.model';
import { ToolSchema, ToolParameterSchema } from '@augmentos/sdk';
import { User } from '../../models/user.model';
import crypto from 'crypto';

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET;
const APPSTORE_ENABLED = true;
export const PRE_INSTALLED = ["com.augmentos.livecaptions", "cloud.augmentos.notify", "cloud.augmentos.mira"];

/**
 * System TPAs that are always available.
 * These are core applications provided by the platform.
 * @Param developerId - leaving this undefined indicates a system app.
 */
export const LOCAL_APPS: AppI[] = [];

// String list of packageNames to preinstall / make uninstallable.

// Fetch from appstore and populate LOCAL_APPS.
(async function loadPreinstalledApps() {
  // Fetch all apps from the app store that are preinstalled.
  const preinstalledApps = await App.find({ packageName: { $in: PRE_INSTALLED } }) as AppI[];

  // Add them to the LOCAL_APPS array.
  preinstalledApps.forEach(app => {
    app.uninstallable = true;
    LOCAL_APPS.push(app);
  });
})();

// export const LOCAL_APPS: AppI[] = [
//   // {
//   //   packageName: systemApps.captions.packageName,
//   //   name: systemApps.captions.name,
//   //   tpaType: TpaType.STANDARD,
//   //   publicUrl: `http://${systemApps.captions.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.captions.packageName}.png`,
//   //   description: systemApps.captions.description
//   // },
//   // {
//   //   packageName: systemApps.notify.packageName,
//   //   name: systemApps.notify.name,
//   //   tpaType: TpaType.BACKGROUND,
//   //   publicUrl: `http://${systemApps.notify.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.notify.packageName}.png`,
//   //   description: systemApps.notify.description,
//   // },
//   // {
//   //   packageName: systemApps.mira.packageName,
//   //   name: systemApps.mira.name,
//   //   tpaType: TpaType.BACKGROUND,
//   //   publicUrl: `http://${systemApps.mira.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.mira.packageName}.png`,
//   //   description: systemApps.mira.description,
//   // },
//   // {
//   //   packageName: systemApps.merge.packageName,
//   //   name: systemApps.merge.name,
//   //   tpaType: TpaType.BACKGROUND,
//   //   publicUrl: `http://${systemApps.merge.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.merge.packageName}.png`,
//   //   description: "Proactive AI that helps you during conversations. Turn it on, have a conversation, and let Merge agents enhance your convo.",
//   // },
//   // {
//   //   packageName: systemApps.liveTranslation.packageName,
//   //   name: systemApps.liveTranslation.name,
//   //   tpaType: TpaType.STANDARD,
//   //   publicUrl: `http://${systemApps.liveTranslation.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.liveTranslation.packageName}.png`,
//   //   description: systemApps.liveTranslation.description,
//   // },
//   // {
//   //   packageName: systemApps.teleprompter.packageName,
//   //   name: "Teleprompt",
//   //   tpaType: TpaType.STANDARD,
//   //   publicUrl: `http://${systemApps.teleprompter.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.teleprompter.packageName}.png`,
//   //   description: systemApps.teleprompter.description,
//   // },
//   // {
//   //   packageName: systemApps.xstats.packageName,
//   //   name: systemApps.xstats.name,
//   //   tpaType: TpaType.BACKGROUND,
//   //   publicUrl: `http://${systemApps.xstats.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.xstats.packageName}.png`,
//   //   description: systemApps.xstats.description,
//   // },
//   // {
//   //   packageName: systemApps.calendarreminder.packageName,
//   //   name: systemApps.calendarreminder.name,
//   //   tpaType: TpaType.BACKGROUND,
//   //   publicUrl: `http://${systemApps.calendarreminder.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.calendarreminder.packageName}.png`,
//   //   description: systemApps.calendarreminder.description,
//   // },
//   // {
//   //   packageName: systemApps.tictactoe.packageName,
//   //   name: systemApps.tictactoe.name,
//   //   tpaType: TpaType.STANDARD,
//   //   publicUrl: `http://${systemApps.tictactoe.host}`,
//   //   logoURL: `https://cloud.augmentos.org/${systemApps.tictactoe.packageName}.png`,
//   //   description: systemApps.tictactoe.description,
//   // }
// ];


/**
 * System TPAs that are always available.
 * These are core applications provided by the platform.
 * @Param developerId - leaving this undefined indicates a system app.
 */
export const SYSTEM_APPS: AppI[] = [
  {
    packageName: systemApps.dashboard.packageName,
    name: systemApps.dashboard.name,
    tpaType: TpaType.SYSTEM_DASHBOARD,
    description: "The time, The news, The weather, The notifications, The everything. 😎🌍🚀",
    publicUrl: `http://${systemApps.dashboard.host}`,
    logoURL: `https://cloud.augmentos.org/${systemApps.dashboard.packageName}.png`,
  },
];

export function isUninstallable(packageName: string) {
  return !PRE_INSTALLED.includes(packageName);
}

/**
 * Implementation of the app management service.
 * Design decisions:
 * 1. Separate system and user TPAs
 * 2. Immutable system TPA list
 * 3. Webhook retry logic
 * 4. API key validation
 */
export class AppService {
  // In-memory cache for app states
  // Map of userId to Map of packageName to AppState
  private appStates = new Map<string, Map<string, AppState>>();

  /**
   * Gets all available TPAs, both system and user-created.
   * @returns Promise resolving to array of all apps
   */
  async getAllApps(userId?: string): Promise<AppI[]> {
    let usersApps: AppI[] = [];

    if (APPSTORE_ENABLED && userId) {
      // Find apps the developer made.
      const _madeByUser = await App.find({ developerId: userId }) as AppI[];

      // Find apps the user installed.
      const user = await User.findOne({ email: userId });
      const _installedApps = user?.installedApps?.map((installedApp: { packageName: string; installedDate: Date; }) => {
        return installedApp.packageName;
      }) || [];

      // Fetch the apps from the appstore.
      const _appstoreApps = await App.find({ packageName: { $in: _installedApps } }) as AppI[];

      // remove duplicates.
      const _allApps = [..._madeByUser, ..._appstoreApps];
      const _appMap = new Map<string, AppI>();
      _allApps.forEach(app => {
        _appMap.set(app.packageName, app);
      });
      
      usersApps.push(..._appMap.values());
      // Filter out any that are already in the LOCAL_APPS map since those would have already been fetched.
      usersApps = usersApps.filter(app => !LOCAL_APPS.some(localApp => localApp.packageName === app.packageName));
    }
    const allApps = [...LOCAL_APPS, ...usersApps];
    return allApps;
  }

  // /**
  //  * Gets available system TPAs.
  //  * @returns array of system apps.
  //  */
  getSystemApps(): AppI[] {
    return SYSTEM_APPS;
  }

  /**
   * Gets a specific TPA by ID.
   * @param packageName - TPA identifier
   * @returns Promise resolving to app if found
   */
  async getApp(packageName: string): Promise<AppI | undefined> {
    // return [...SYSTEM_TPAS, ...APP_STORE].find(app => app.packageName === packageName);
    let app: AppI | undefined = [...SYSTEM_APPS, ...LOCAL_APPS].find(app => app.packageName === packageName);
    // if we can't find the app, try checking the appstore via the App Mongodb model.

    if (APPSTORE_ENABLED) {
      if (!app) {
        // Check if the app is in the app store
        console.log('Checking app store for app:', packageName);
        app = await App.findOne({
          packageName: packageName
        }) as AppI;
      }
    }

    return app;
  }

  async findFromAppStore(packageName: string): Promise<AppI | undefined> {
    const app = await App.findOne({
      packageName: packageName
    }) as AppI;
    return app;
  }

  /**
   * Triggers a webhook for a TPA.
   * @param url - Webhook URL
   * @param payload - Data to send
   * @throws If webhook fails after retries
   */
  async triggerWebhook(url: string, payload: SessionWebhookRequest): Promise<void> {
    const maxRetries = 2;
    const baseDelay = 1000; // 1 second

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000 // Increase timeout to 10 seconds
        });
        return;
      } catch (error: unknown) {
        if (attempt === maxRetries - 1) {
          if (axios.isAxiosError(error)) {
            console.error(`Webhook failed: ${error}`);
            console.error(`URL: ${url}`);
            console.error(`Response: ${error.response?.data}`);
            console.error(`Status: ${error.response?.status}`);
          }
          throw new Error(`Webhook failed after ${maxRetries} attempts: ${(error as AxiosError).message || 'Unknown error'}`);
        }
        // Exponential backoff
        await new Promise(resolve =>
          setTimeout(resolve, baseDelay * Math.pow(2, attempt))
        );
      }
    }
  }

  /**
 * Triggers the stop webhook for a TPA app session.
 * @param url - Stop Webhook URL
 * @param payload - Data to send
 * @throws If stop webhook fails
 */
  async triggerStopWebhook(publicUrl: string, payload: StopWebhookRequest): Promise<{
    status: number;
    data: WebhookResponse;
  }> {
    // Construct the stop webhook URL from the app's public URL
    const webhookUrl = `${publicUrl}/webhook`;
    const response = await axios.post(webhookUrl, payload);
    return {
      status: response.status,
      data: response.data
    };
  }

  isSystemApp(packageName: string, apiKey?: string): boolean {
    // Check if the app is in the system apps list
    const isSystemApp = [...LOCAL_APPS, ...SYSTEM_APPS].some(app => app.packageName === packageName);
    // or if the xxx.yyy.zzz if the xxx == "system" or "local"
    const _isSystemApp = packageName.split('.').length > 2 && (packageName.split('.')[0] === 'system' || packageName.split('.')[0] === 'local');

    return isSystemApp || (_isSystemApp && apiKey === AUGMENTOS_AUTH_JWT_SECRET);
  }

  /**
   * Validates a TPA's API key.
   * @param packageName - TPA identifier
   * @param apiKey - API key to validate
   * @param clientIp - Optional IP address of the client for system app validation
   * @returns Promise resolving to validation result
   */
  async validateApiKey(packageName: string, apiKey: string, clientIp?: string): Promise<boolean> {
    const app = await this.getApp(packageName);
    if (!app) {
      console.warn(`App ${packageName} not found`);
      return false;
    }

    if (this.isSystemApp(packageName, apiKey)) {
      return true;
    }

    // Additional verification for system apps
    // If a system app, verify it's coming from the internal cluster network. note: for some reason this doesn't work in porter. but does work if running the cloud from docker-compose on the azure vm.
    if (clientIp) {
      // Check if IP is from the internal network
      // Docker networks typically use 172.x.x.x, 10.x.x.x, or 192.168.x.x
      // Kubernetes pod IPs depend on your cluster configuration
      // Handle IPv6-mapped IPv4 addresses (::ffff:a.b.c.d)
      const ipv4 = clientIp.startsWith('::ffff:') ? clientIp.substring(7) : clientIp;

      const isInternalIp = ipv4.startsWith('10.') ||
        ipv4.startsWith('172.') ||
        ipv4.startsWith('192.168.') ||
        // For Kubernetes cluster IPs (adjust based on your actual cluster IP range)
        ipv4.includes('.svc.cluster.local') ||
        clientIp === '::ffff:127.0.0.1' ||
        ipv4 === '127.0.0.1' ||
        ipv4 === 'localhost';

      console.log(`System app ${packageName} connection IP check: ${clientIp} (IPv4: ${ipv4}), isInternal: ${isInternalIp}`);

      if (isInternalIp) {
        // Reject connection if not from internal network
        console.warn(`System app ${packageName} connection is an internal IP: ${clientIp} (IPv4: ${ipv4}) - allowing access`);
        return true;
      }
    }

    // For regular apps, validate API key as normal
    // Get the MongoDB app document to access hashedApiKey
    const appDoc = await App.findOne({ packageName });

    if (!appDoc) {
      console.warn(`App ${packageName} not found in database`);
      return false;
    }

    // Check if the app has a hashed API key
    // If the app is a system app, we don't need to validate the API key

    if (!appDoc?.hashedApiKey) {
      console.warn(`App ${packageName} does not have a hashed API key`);
      return false;
    }

    // Hash the provided API key and compare with stored hash
    const hashedKey = this.hashApiKey(apiKey);

    console.log(`Validating API key for ${packageName}: ${hashedKey} === ${appDoc.hashedApiKey}`);
    // Compare the hashed API key with the stored hashed API key

    return hashedKey === appDoc.hashedApiKey;
  }

  /**
   * Gets the current state of a TPA for a user.
   * @param packageName - TPA identifier
   * @param userId - User identifier
   * @returns Promise resolving to app state
   */
  async getAppState(packageName: string, userId: string): Promise<AppState> {
    const userStates = this.appStates.get(userId) || new Map<string, AppState>();

    // Return existing state or default to not_installed
    return userStates.get(packageName) || AppState.NOT_INSTALLED;
  }

  /**
   * Validates tool definitions against the schema requirements
   * @param tools Array of tool definitions to validate
   * @returns Validated and sanitized tools array or throws error if invalid
   */
  private validateToolDefinitions(tools: any[]): ToolSchema[] {
    console.log('Validating tool definitions:', tools);
    if (!Array.isArray(tools)) {
      throw new Error('Tools must be an array');
    }
    
    return tools.map(tool => {
      // Validate required fields
      if (!tool.id || typeof tool.id !== 'string') {
        throw new Error('Tool id is required and must be a string');
      }
      
      if (!tool.description || typeof tool.description !== 'string') {
        throw new Error('Tool description is required and must be a string');
      }
      
      // Activation phrases can be null or empty, no validation needed
      // We'll just ensure it's an array if provided
      if (tool.activationPhrases && !Array.isArray(tool.activationPhrases)) {
        throw new Error('Tool activationPhrases must be an array if provided');
      }
      
      // Validate parameters if they exist
      const validatedParameters: Record<string, ToolParameterSchema> = {};
      
      if (tool.parameters) {
        Object.entries(tool.parameters).forEach(([key, param]: [string, any]) => {
          if (!param.type || !['string', 'number', 'boolean'].includes(param.type)) {
            throw new Error(`Parameter ${key} has invalid type. Must be string, number, or boolean`);
          }
          
          if (!param.description || typeof param.description !== 'string') {
            throw new Error(`Parameter ${key} requires a description`);
          }
          
          validatedParameters[key] = {
            type: param.type as 'string' | 'number' | 'boolean',
            description: param.description,
            required: !!param.required
          };
          
          // Add enum values if present
          if (param.enum && Array.isArray(param.enum)) {
            validatedParameters[key].enum = param.enum;
          }
        });
      }
      
      return {
        id: tool.id,
        description: tool.description,
        activationPhrases: tool.activationPhrases.map((p: string) => p.trim()),
        parameters: Object.keys(validatedParameters).length > 0 ? validatedParameters : undefined
      };
    });
  }

  /**
   * Create a new app
   */
  async createApp(appData: any, developerId: string): Promise<{ app: AppI, apiKey: string }> {
    // Generate API key
    const apiKey = crypto.randomBytes(32).toString('hex');
    const hashedApiKey = this.hashApiKey(apiKey);
    
    // Parse and validate tools if present
    if (appData.tools) {
      try {
        appData.tools = this.validateToolDefinitions(appData.tools);
      } catch (error: any) {
        throw new Error(`Invalid tool definitions: ${error.message}`);
      }
    }
    
    // Create app
    const app = await App.create({
      ...appData,
      developerId,
      hashedApiKey
    });

    return { app, apiKey };
  }


  /**
   * Update an app
   */
  async updateApp(packageName: string, appData: any, developerId: string): Promise<AppI> {
    // Ensure developer owns the app
    const app = await App.findOne({ packageName });

    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }

    if (!developerId) {
      throw new Error('Developer ID is required');
    }

    if (!app.developerId) {
      throw new Error('Developer ID not found for this app');
    }

    if (app.developerId.toString() !== developerId) {
      throw new Error('You do not have permission to update this app');
    }
    
    // Parse and validate tools if present
    if (appData.tools) {
      try {
        appData.tools = this.validateToolDefinitions(appData.tools);
      } catch (error: any) {
        throw new Error(`Invalid tool definitions: ${error.message}`);
      }
    }
    
    // If developerInfo is provided, ensure it's properly structured
    if (appData.developerInfo) {
      // Make sure only valid fields are included
      const validFields = ['company', 'website', 'contactEmail', 'description'];
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
      { new: true }
    );

    return updatedApp!;
  }

  /**
   * Publish an app to the app store
   */
  async publishApp(packageName: string, developerId: string): Promise<AppI> {
    // Ensure developer owns the app
    const app = await App.findOne({ packageName });

    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }

    if (!developerId) {
      throw new Error('Developer ID is required');
    }

    if (!app.developerId) {
      throw new Error('Developer ID not found for this app');
    }

    if (app.developerId.toString() !== developerId) {
      throw new Error('You do not have permission to publish this app');
    }

    // Verify that the developer has filled out the required profile information
    const developer = await User.findOne({ email: developerId });
    if (!developer) {
      throw new Error('Developer not found');
    }

    // Check if developer profile has the required fields
    if (!developer.profile?.company || !developer.profile?.contactEmail) {
      throw new Error('PROFILE_INCOMPLETE: Developer profile is incomplete. Please fill out your company name and contact email before publishing an app.');
    }

    // Update app status to SUBMITTED
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: { appStoreStatus: 'SUBMITTED' } },
      { new: true }
    );

    return updatedApp!;
  }

  /**
   * Delete an app
   */
  async deleteApp(packageName: string, developerId: string): Promise<void> {
    // Ensure developer owns the app
    const app = await App.findOne({ packageName });

    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }

    if (!developerId) {
      throw new Error('Developer ID is required');
    }

    if (!app.developerId) {
      throw new Error('Developer ID not found for this app');
    }


    if (app.developerId.toString() !== developerId) {
      throw new Error('You do not have permission to delete this app');
    }

    await App.findOneAndDelete({ packageName });
  }

  /**
   * Regenerate API key for an app
   */
  async regenerateApiKey(packageName: string, developerId: string): Promise<string> {
    // Ensure developer owns the app
    const app = await App.findOne({ packageName });

    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }

    if (!developerId) {
      throw new Error('Developer ID is required');
    }

    if (!app.developerId) {
      throw new Error('Developer ID not found for this app');
    }

    if (app.developerId.toString() !== developerId) {
      throw new Error('You do not have permission to update this app');
    }

    // Generate new API key
    const apiKey = crypto.randomBytes(32).toString('hex');
    const hashedApiKey = this.hashApiKey(apiKey);

    // Update app with new hashed API key
    await App.findOneAndUpdate(
      { packageName },
      { $set: { hashedApiKey } }
    );

    return apiKey;
  }

  /**
   * Hash API key
   */
  hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Hash a string using an app's hashed API key
   * @param stringToHash - String to be hashed
   * @param packageName - Package name of the app to use its hashed API key
   * @returns Promise resolving to the resulting hash string
   */
  async hashWithApiKey(stringToHash: string, packageName: string): Promise<string> {
    const app = await App.findOne({ packageName });
    
    if (!app || !app.hashedApiKey) {
      throw new Error(`App ${packageName} not found or has no API key`);
    }
    
    // Create a hash using the provided string and the app's hashed API key
    return crypto.createHash('sha256')
      .update(stringToHash)
      .update(app.hashedApiKey)
      .digest('hex');
  }

  /**
   * Get apps by developer ID
   */
  async getAppsByDeveloperId(developerId: string): Promise<AppI[]> {
    return App.find({ developerId }).lean();
  }

  /**
   * Get app by package name
   */
  async getAppByPackageName(packageName: string, developerId?: string): Promise<AppI | null> {
    const query: any = { packageName };

    // If developerId is provided, ensure the app belongs to this developer
    if (developerId) {
      query.developerId = developerId;
    }

    return App.findOne(query).lean();
  }

  /**
   * Get public apps
   * TODO: DELETE THIS?
   */
  // export async function getPublicApps(developerEmail?: string): Promise<AppI[]> {
  async getPublicApps(): Promise<AppI[]> {
    // console.log('Getting public apps - developerEmail', developerEmail);
    // if (developerEmail) {
    //   const developer
    //     = await User.findOne({ email: developerEmail }).lean();
    //   if (!developer) {
    //     return App.find({ isPublic: true }).lean();
    //   }
    //   else {
    //     // Find all public apps, or apps by the developer.
    //     return App.find({ $or: [{ isPublic: true }, { developerId: developer.email}] }).lean();
    //   }
    // }
    return App.find({ isPublic: true }).lean();
    // return App.find();
  }

  /**
   * Get all available apps for the app store
   * Only returns apps with PUBLISHED status
   */
  async getAvailableApps(): Promise<AppI[]> {
    return App.find({ appStoreStatus: 'PUBLISHED' });
  }

  /**
   * Triggers the TPA tool webhook for Mira AI integration
   * @param packageName - The package name of the TPA to send the tool to
   * @param payload - The tool webhook payload containing tool details
   * @returns Promise resolving to the webhook response or error
   */
  async triggerTpaToolWebhook(packageName: string, payload: ToolCall): Promise<{
    status: number;
    data: any;
  }> {
    // Look up the TPA by packageName
    const app = await this.getApp(packageName);

    console.log('🔨 Triggering tool webhook for:', packageName);
    
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
    // The TPA server will need to validate this using the hashedApiKey
    
    // Construct the webhook URL from the app's public URL
    const webhookUrl = `${app.publicUrl}/tool`;
    
    // Set up retry configuration
    const maxRetries = 2;
    const baseDelay = 1000; // 1 second

    console.log('🔨 Sending tool webhook to:', webhookUrl);
    console.log('🔨 Payload:', payload);
    
    // Attempt to send the webhook with retries
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await axios.post(webhookUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-TPA-API-Key': appDoc.hashedApiKey, // Use the hashed API key for authentication
          },
          timeout: 10000 // 10 second timeout
        });
        
        // Return successful response
        return {
          status: response.status,
          data: response.data
        };
      } catch (error: unknown) {
        // If this is the last retry attempt, throw an error
        if (attempt === maxRetries - 1) {
          if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError;
            console.error(`Tool webhook failed for ${packageName}: ${axiosError.message}`);
            console.error(`URL: ${webhookUrl}`);
            console.error(`Response: ${axiosError.response?.data}`);
            console.error(`Status: ${axiosError.response?.status}`);
            
            // Return a standardized error response
            return {
              status: axiosError.response?.status || 500,
              data: {
                error: true,
                message: `Webhook failed: ${axiosError.message}`,
                details: axiosError.response?.data || {}
              }
            };
          } else {
            // Handle non-Axios errors
            const genericError = error as Error;
            return {
              status: 500,
              data: {
                error: true,
                message: `Webhook failed: ${genericError.message || 'Unknown error'}`
              }
            };
          }
        }
        
        // Exponential backoff before retry
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
      }
    }
    
    // This should never be reached due to the error handling above,
    // but TypeScript requires a return value
    return {
      status: 500,
      data: {
        error: true,
        message: 'Unknown error occurred'
      }
    };
  }

  /**
   * Gets all tool definitions for a TPA
   * Used by Mira AI to discover available tools
   * @param packageName - The package name of the TPA
   * @returns Array of tool definitions
   */
  async getTpaTools(packageName: string): Promise<ToolSchema[]> {
    // Look up the TPA by packageName
    const app = await this.getApp(packageName);
    
    if (!app) {
      throw new Error(`App ${packageName} not found`);
    }
    
    if (!app.publicUrl) {
      throw new Error(`App ${packageName} does not have a public URL`);
    }

    console.log('Getting TPA tools for:', packageName);
    
    try {
      // Fetch the tpa_config.json from the app's publicUrl
      const configUrl = `${app.publicUrl}/tpa_config.json`;
      const response = await axios.get(configUrl, { timeout: 5000 });

      // Check if the response contains a tools array
      const config = response.data;
      if (config && Array.isArray(config.tools)) {
        // Validate the tools before returning them
        console.log(`Found ${config.tools.length} tools in ${packageName}, validating...`);
        return this.validateToolDefinitions(config.tools);
      }
      
      // If no tools found, return empty array
      return [];
    } catch (error) {
      // Check if error is a 404 (file not found) and silently ignore
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // Config file doesn't exist, silently return empty array
        console.log(`No tpa_config.json found for app ${packageName} (404)`);
        return [];
      }
      
      // Log other errors but still return empty array
      //console.error(`Failed to fetch tpa_config.json for app ${packageName}:`, error);
      return [];
    }
  }

}

// Create singleton instance
export const appService = new AppService();
console.log('✅ App Service');

export default appService;