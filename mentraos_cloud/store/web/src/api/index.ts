// store/web/src/services/api.service.ts
import { AppI } from "@/types";
import axios from "axios";

// Configure base axios defaults
axios.defaults.withCredentials = true;
axios.defaults.baseURL = import.meta.env.VITE_CLOUD_API_URL || "http://localhost:8002";

// Response interfaces
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

// Token exchange response
export interface TokenExchangeResponse {
  coreToken: string;
}

// Temporary token exchange response
export interface TempTokenExchangeResponse {
  success: boolean;
  userId?: string;
  tokens?: {
    supabaseToken?: string;
    coreToken?: string;
  };
  error?: string;
}

// User interface
export interface User {
  id: string;
  email: string;
  createdAt?: string;
}

// Filter options interface
export interface AppFilterOptions {
  organizationId?: string;
}

// App service functions
const appService = {
  /**
   * Get all public apps (no auth required)
   * Uses store backend
   */
  getPublicApps: async (): Promise<AppI[]> => {
    try {
      const response = await axios.get<ApiResponse<AppI[]>>(
        `/api/apps/public`
      );
      return response.data.data || [];
    } catch (error) {
      console.error("Error fetching public apps:", error);
      return []; // Return empty array on error
    }
  },

  /**
   * Get all available apps (auth required)
   * Uses store backend
   * @param options Optional filter options
   */
  getAvailableApps: async (options?: AppFilterOptions): Promise<AppI[]> => {
    try {
      let url = `/api/apps/available`;

      // Add organization filter if provided
      if (options?.organizationId) {
        url += `?organizationId=${encodeURIComponent(options.organizationId)}`;
      }

      const response = await axios.get<ApiResponse<AppI[]>>(url);
      return response.data.data;
    } catch (error) {
      console.error("Error fetching available apps:", error);
      throw error;
    }
  },

  /**
   * Get user's installed apps (auth required)
   * Uses store backend
   */
  getInstalledApps: async (): Promise<AppI[]> => {
    try {
      const response = await axios.get<ApiResponse<AppI[]>>(
        `/api/apps/installed`
      );
      return response.data.data;
    } catch (error) {
      console.error("Error fetching installed apps:", error);
      throw error;
    }
  },

  /**
   * Get app details by package name (no auth required)
   * Uses store backend
   */
  getAppByPackageName: async (packageName: string): Promise<AppI | null> => {
    try {
      const response = await axios.get<ApiResponse<AppI>>(
        `/api/apps/${packageName}`
      );
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching app ${packageName}:`, error);
      return null;
    }
  },

  /**
   * Install an app (auth required)
   * Uses cloud backend
   */
  installApp: async (packageName: string): Promise<boolean> => {
    try {
      const response = await axios.post<ApiResponse<null>>(
        `/api/apps/install/${packageName}`
      );
      return response.data.success;
    } catch (error) {
      console.error(`Error installing app ${packageName}:`, error);
      throw error;
    }
  },

  /**
   * Uninstall an app (auth required)
   * Uses cloud backend
   */
  uninstallApp: async (packageName: string): Promise<boolean> => {
    try {
      // First stop the app and verify it was successful
      // const stopSuccess = await appService.stopApp(packageName);
      // if (!stopSuccess) {
      //   throw new Error(`Failed to stop app ${packageName} before uninstallation`);
      // }
      // backend will stop the app automatically if it is running.

      // Then uninstall it
      const response = await axios.post<ApiResponse<null>>(
        `/api/apps/uninstall/${packageName}`
      );
      return response.data.success;
    } catch (error) {
      console.error(`Error uninstalling app ${packageName}:`, error);
      throw error;
    }
  },

  /**
   * Start an app (auth required)
   * Uses cloud backend
   */
  startApp: async (packageName: string): Promise<boolean> => {
    try {
      const response = await axios.post<ApiResponse<null>>(
        `/api/apps/${packageName}/start`,
      );
      return response.data.success;
    } catch (error) {
      console.error(`Error starting app ${packageName}:`, error);
      throw error;
    }
  },

  /**
   * Stop an app (auth required)
   * Uses cloud backend
   */
  stopApp: async (packageName: string): Promise<boolean> => {
    try {
      const response = await axios.post<ApiResponse<null>>(
        `/api/apps/${packageName}/stop`,
      );
      return response.data.success;
    } catch (error) {
      console.error(`Error stopping app ${packageName}:`, error);
      throw error;
    }
  },

  /**
   * Search for apps (no auth required)
   * Uses store backend
   * @param query Search query string
   * @param options Optional filter options
   */
  searchApps: async (query: string, options?: AppFilterOptions): Promise<AppI[]> => {
    try {
      let url = `/api/apps/search?q=${encodeURIComponent(query)}`;

      // Add organization filter if provided
      if (options?.organizationId) {
        url += `&organizationId=${encodeURIComponent(options.organizationId)}`;
      }

      const response = await axios.get<ApiResponse<AppI[]>>(url);
      return response.data.data || [];
    } catch (error) {
      console.error(`Error searching apps with query "${query}":`, error);
      return []; // Return empty array on error
    }
  }
};

// User service functions
const userService = {
  /**
   * Get current user info (auth required)
   * Uses store backend
   */
  getCurrentUser: async (): Promise<User | null> => {
    try {
      const response = await axios.get<ApiResponse<User>>(
        `/api/user/me`
      );
      return response.data.data;
    } catch (error) {
      console.error("Error fetching current user:", error);
      return null;
    }
  }
};

// Auth service functions
const authService = {
  /**
   * Exchange a Supabase token for a Core token
   * @param supabaseToken The Supabase JWT token
   * @returns Promise with the Core token
   */
  exchangeToken: async (supabaseToken: string): Promise<string> => {
    try {
      const response = await axios.post<TokenExchangeResponse>(
        `/api/auth/exchange-token`,
        { supabaseToken },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (response.status === 200 && response.data.coreToken) {
        return response.data.coreToken;
      } else {
        throw new Error(`Failed to exchange token: ${response.statusText}`);
      }
    } catch (error) {
      console.error("Error exchanging token:", error);
      throw error;
    }
  },

  /**
   * Exchange a temporary token for user tokens
   * @param tempToken The temporary token from URL
   * @param packageName The package name requesting the exchange
   * @returns Promise with exchange result containing tokens and user ID
   */
  exchangeTemporaryToken: async (tempToken: string, packageName: string): Promise<TempTokenExchangeResponse> => {
    try {
      const response = await axios.post<TempTokenExchangeResponse>(
        `/api/auth/exchange-store-token`,
        { aos_temp_token: tempToken, packageName },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (response.status === 200 && response.data.success) {
        return response.data;
      } else {
        return {
          success: false,
          error: response.data.error || `Failed with status ${response.status}`
        };
      }
    } catch (error) {
      console.error("Error exchanging temporary token:", error);
      if (axios.isAxiosError(error) && error.response) {
        return {
          success: false,
          error: error.response.data?.error || error.message
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }
  }
};

// Set up auth token interceptor
export const setAuthToken = (token: string | null) => {
  if (token) {
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common["Authorization"];
  }
};

// Export services
export default {
  app: appService,
  user: userService,
  auth: authService,
  setAuthToken
};