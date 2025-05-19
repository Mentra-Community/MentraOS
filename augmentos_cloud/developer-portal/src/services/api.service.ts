// src/services/api.service.ts
import axios from "axios";
import { Permission, TPA } from "@/types/tpa";
import { AppI } from "@augmentos/sdk";

// Set default config
axios.defaults.baseURL = import.meta.env.VITE_API_URL || "http://localhost:8002";
axios.defaults.withCredentials = true;
console.log("API URL", axios.defaults.baseURL);

// Helper function to wait a specified time
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to retry a function with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>, 
  retries = 3, 
  initialDelay = 300,
  maxDelay = 2000
): Promise<T> {
  let currentDelay = initialDelay;
  
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      
      // Check if this is an auth error, and if auth token might not be ready
      if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        console.log(`Auth error on attempt ${i+1}, retrying after ${currentDelay}ms...`);
        await delay(currentDelay);
        currentDelay = Math.min(currentDelay * 2, maxDelay);
      } else {
        throw error;
      }
    }
  }
  
  throw new Error('Max retries reached');
}

// Extended TPA interface for API responses
export interface AppResponse extends AppI {
  id: string; // Add id property to match TPA interface
  createdAt: string;
  updatedAt: string;
  publicUrl: string;
  appStoreStatus?: 'DEVELOPMENT' | 'SUBMITTED' | 'REJECTED' | 'PUBLISHED';
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  sharedWithEmails?: string[];
}

// API key response
export interface ApiKeyResponse {
  apiKey: string;
  createdAt: string;
}

// Developer user interface
export interface DeveloperUser {
  id: string;
  email: string;
  name?: string;
  profile?: {
    company?: string;
    website?: string;
    contactEmail?: string;
    description?: string;
    logo?: string;
  };
  createdAt: string;
}

const api = {
  // Authentication endpoints
  auth: {
    me: async (): Promise<DeveloperUser> => {
      const response = await axios.get("/api/dev/auth/me");
      return response.data;
    },
    
    // Update developer profile
    updateProfile: async (profileData: unknown): Promise<DeveloperUser> => {
      const response = await axios.put("/api/dev/auth/profile", profileData);
      return response.data;
    },
  },

  // TPA management endpoints
  apps: {
    // Get all TPAs for the current developer
    getAll: async (): Promise<AppResponse[]> => {
      return retryWithBackoff(async () => {
        const response = await axios.get("/api/dev/apps");
        return response.data;
      });
    },

    // Get a specific TPA by package name
    getByPackageName: async (packageName: string): Promise<AppResponse> => {
      const response = await axios.get(`/api/dev/apps/${packageName}`);
      return response.data;
    },

    // Create a new TPA
    // create: async (tpaData: Omit<TPA, "id">): Promise<{ tpa: TPAResponse; apiKey: string }> => {
    create: async (tpaData: AppI): Promise<{ app: AppResponse; apiKey: string }> => {
      const response = await axios.post("/api/dev/apps/register", tpaData);
      return response.data;
    },

    // Update an existing TPA
    update: async (packageName: string, tpaData: Partial<TPA>): Promise<AppResponse> => {
      const response = await axios.put(`/api/dev/apps/${packageName}`, tpaData);
      return response.data;
    },

    // Delete a TPA
    delete: async (packageName: string): Promise<void> => {
      await axios.delete(`/api/dev/apps/${packageName}`);
    },

    // Publish an app to the app store
    publish: async (packageName: string): Promise<AppResponse> => {
      const response = await axios.post(`/api/dev/apps/${packageName}/publish`);
      return response.data;
    },

    // API key management
    apiKey: {
      // Generate a new API key for a TPA
      regenerate: async (packageName: string): Promise<ApiKeyResponse> => {
        const response = await axios.post(`/api/dev/apps/${packageName}/api-key`);
        return response.data;
      },
    },
    
    // Permissions management
    permissions: {
      // Get permissions for a TPA
      get: async (packageName: string): Promise<{permissions: Permission[]}> => {
        const response = await axios.get(`/api/permissions/${packageName}`);
        return response.data;
      },
      
      // Update permissions for a TPA
      update: async (packageName: string, permissions: Permission[]): Promise<{permissions: Permission[]}> => {
        const response = await axios.patch(`/api/permissions/${packageName}`, { permissions });
        return response.data;
      },
    },

    // Update app visibility (sharedWithOrganization)
    updateVisibility: async (packageName: string, sharedWithOrganization: boolean): Promise<AppResponse> => {
      const response = await axios.patch(`/api/dev/apps/${packageName}/visibility`, { sharedWithOrganization });
      return response.data;
    },

    // Update sharedWithEmails
    updateSharedEmails: async (packageName: string, emails: string[]): Promise<AppResponse> => {
      const response = await axios.patch(`/api/dev/apps/${packageName}/share-emails`, { emails });
      return response.data;
    },
  },

  // Installation sharing endpoints
  sharing: {
    // Get a shareable installation link for a TPA
    getInstallLink: async (packageName: string): Promise<string> => {
      const response = await axios.get(`/api/dev/apps/${packageName}/share`);
      return response.data.installUrl;
    },

    // Track that a TPA has been shared with a specific email
    trackSharing: async (packageName: string, emails: string[]): Promise<void> => {
      await axios.post(`/api/dev/apps/${packageName}/share`, { emails });
    },
  },
  
  // Admin panel endpoints
  admin: {
    // Check if user is an admin
    checkAdmin: async (): Promise<{ isAdmin: boolean, role: string, email: string }> => {
      const response = await axios.get('/api/admin/check');
      return response.data;
    },
    
    // Get admin dashboard stats
    getStats: async () => {
      const response = await axios.get('/api/admin/apps/stats');
      return response.data;
    },
    
    // Get submitted apps
    getSubmittedApps: async () => {
      const response = await axios.get('/api/admin/apps/submitted');
      return response.data;
    },
    
    // Get app details
    getAppDetail: async (packageName: string) => {
      const response = await axios.get(`/api/admin/apps/${packageName}`);
      return response.data;
    },
    
    // Approve an app
    approveApp: async (packageName: string, notes: string) => {
      const response = await axios.post(`/api/admin/apps/${packageName}/approve`, { notes });
      return response.data;
    },
    
    // Reject an app
    rejectApp: async (packageName: string, notes: string) => {
      const response = await axios.post(`/api/admin/apps/${packageName}/reject`, { notes });
      return response.data;
    },
    
    // Admin user management
    users: {
      // Get all admin users
      getAll: async () => {
        const response = await axios.get('/api/admin/users');
        return response.data;
      },
      
      // Add a new admin user
      add: async (email: string, role: string) => {
        const response = await axios.post('/api/admin/users', { email, role });
        return response.data;
      },
      
      // Remove an admin user
      remove: async (email: string) => {
        const response = await axios.delete(`/api/admin/users/${email}`);
        return response.data;
      }
    },
    
    // Debug route that doesn't require authentication
    debug: async () => {
      const response = await axios.get('/api/admin/debug');
      return response.data;
    },
    
    // Fix app status issues
    fixAppStatuses: async () => {
      const response = await axios.post('/api/admin/fix-app-statuses');
      return response.data;
    },
    
    // Create a test submission (development only)
    createTestSubmission: async () => {
      const response = await axios.post('/api/admin/create-test-submission');
      return response.data;
    }
  }
};

export default api;