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
  organizations?: string[]; // Array of organization IDs
  defaultOrg?: string; // Default organization ID
  createdAt: string;
}

/**
 * Organization member role
 */
export type OrgRole = 'admin' | 'member';

/**
 * Organization member interface
 */
export interface OrgMember {
  user: {
    id: string;
    email: string;
    displayName?: string;
    profile?: {
      avatar?: string;
    };
  };
  role: OrgRole;
  joinedAt: string;
}

/**
 * Pending invitation interface
 */
export interface PendingInvite {
  email: string;
  role: OrgRole;
  token: string;
  invitedBy: {
    id: string;
    email: string;
    displayName?: string;
  };
  invitedAt: string;
  expiresAt: string;
  emailSentCount: number;
  lastEmailSentAt?: string;
}

/**
 * Organization interface
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  profile: {
    website?: string;
    contactEmail: string;
    description?: string;
    logo?: string;
  };
  members: OrgMember[];
  pendingInvites?: PendingInvite[];
  createdAt: string;
  updatedAt: string;
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

  // Organization endpoints
  orgs: {
    /**
     * List all organizations the current user is a member of
     */
    list: async (): Promise<Organization[]> => {
      const response = await axios.get("/api/orgs");
      return response.data.data;
    },

    /**
     * Create a new organization
     * @param name - The name of the organization
     */
    create: async (name: string): Promise<Organization> => {
      const response = await axios.post("/api/orgs", { name });
      return response.data.data;
    },

    /**
     * Get a specific organization by ID
     * @param orgId - The organization ID
     */
    get: async (orgId: string): Promise<Organization> => {
      const response = await axios.get(`/api/orgs/${orgId}`);
      return response.data.data;
    },

    /**
     * Update an organization's details
     * @param orgId - The organization ID
     * @param data - The updated organization data
     */
    update: async (orgId: string, data: Partial<Organization>): Promise<Organization> => {
      const response = await axios.put(`/api/orgs/${orgId}`, data);
      return response.data.data;
    },

    /**
     * Invite a new member to the organization
     * @param orgId - The organization ID
     * @param email - The invitee's email address
     * @param role - The role to assign to the invitee (default: 'member')
     */
    invite: async (orgId: string, email: string, role: OrgRole = 'member'): Promise<{ inviteToken: string }> => {
      const response = await axios.post(`/api/orgs/${orgId}/members`, { email, role });
      return response.data.data;
    },

    /**
     * Get members of an organization
     * @param orgId - The organization ID
     */
    members: async (orgId: string): Promise<OrgMember[]> => {
      const response = await axios.get(`/api/orgs/${orgId}`);
      return response.data.data.members;
    },

    /**
     * Change a member's role in the organization
     * @param orgId - The organization ID
     * @param memberId - The member's user ID
     * @param role - The new role
     */
    changeRole: async (orgId: string, memberId: string, role: OrgRole): Promise<Organization> => {
      const response = await axios.patch(`/api/orgs/${orgId}/members/${memberId}`, { role });
      return response.data.data;
    },

    /**
     * Remove a member from the organization
     * @param orgId - The organization ID
     * @param memberId - The member's user ID
     */
    removeMember: async (orgId: string, memberId: string): Promise<{ success: boolean }> => {
      const response = await axios.delete(`/api/orgs/${orgId}/members/${memberId}`);
      return response.data;
    },

    /**
     * Accept an invitation to join an organization
     * @param token - The invitation token
     */
    acceptInvite: async (token: string): Promise<Organization> => {
      const response = await axios.post(`/api/orgs/accept/${token}`);
      return response.data.data;
    },

    /**
     * Resend an invitation email
     * @param orgId - The organization ID
     * @param email - The email address of the pending invite
     */
    resendInvite: async (orgId: string, email: string): Promise<{ success: boolean; message: string }> => {
      const response = await axios.post(`/api/orgs/${orgId}/invites/resend`, { email });
      return response.data;
    },

    /**
     * Rescind (cancel) a pending invitation
     * @param orgId - The organization ID
     * @param email - The email address of the pending invite
     */
    rescindInvite: async (orgId: string, email: string): Promise<{ success: boolean; message: string }> => {
      const response = await axios.post(`/api/orgs/${orgId}/invites/rescind`, { email });
      return response.data;
    },

    /**
     * Delete an organization
     * @param orgId - The organization ID
     */
    delete: async (orgId: string): Promise<{ success: boolean; message: string }> => {
      const response = await axios.delete(`/api/orgs/${orgId}`);
      return response.data;
    },
  },

  // TPA management endpoints
  apps: {
    // Get all TPAs for the current organization
    getAll: async (orgId?: string): Promise<AppResponse[]> => {
      return retryWithBackoff(async () => {
        const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
        const response = await axios.get("/api/dev/apps", config);
        return response.data;
      });
    },

    // Get a specific TPA by package name
    getByPackageName: async (packageName: string, orgId?: string): Promise<AppResponse> => {
      const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
      const response = await axios.get(`/api/dev/apps/${packageName}`, config);
      return response.data;
    },

    // Create a new TPA
    create: async (orgId: string, tpaData: AppI): Promise<{ app: AppResponse; apiKey: string }> => {
      const response = await axios.post("/api/dev/apps/register", tpaData, {
        headers: { 'x-org-id': orgId }
      });
      return response.data;
    },

    // Update an existing TPA
    update: async (packageName: string, tpaData: Partial<TPA>, orgId?: string): Promise<AppResponse> => {
      const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
      const response = await axios.put(`/api/dev/apps/${packageName}`, tpaData, config);
      return response.data;
    },

    // Delete a TPA
    delete: async (packageName: string, orgId?: string): Promise<void> => {
      const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
      await axios.delete(`/api/dev/apps/${packageName}`, config);
    },

    // Publish an app to the app store
    publish: async (packageName: string, orgId?: string): Promise<AppResponse> => {
      const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
      const response = await axios.post(`/api/dev/apps/${packageName}/publish`, {}, config);
      return response.data;
    },

    // Move a TPA to a different organization
    moveToOrg: async (packageName: string, targetOrgId: string, sourceOrgId: string): Promise<AppResponse> => {
      const response = await axios.post(
        `/api/dev/apps/${packageName}/move-org`,
        { targetOrgId },
        { headers: { 'x-org-id': sourceOrgId } }
      );
      return response.data;
    },

    // API key management
    apiKey: {
      // Generate a new API key for a TPA
      regenerate: async (packageName: string, orgId?: string): Promise<ApiKeyResponse> => {
        const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
        const response = await axios.post(`/api/dev/apps/${packageName}/api-key`, {}, config);
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

    // These are deprecated but kept for backwards compatibility during transition
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

  // Image upload endpoints for Cloudflare Images
  images: {
    /**
     * Upload an image to Cloudflare Images
     * @param file - The image file to upload
     * @param metadata - Optional metadata for the image
     * @returns The Cloudflare image URL
     */
    upload: async (file: File, metadata?: { appPackageName?: string }): Promise<{ url: string; imageId: string }> => {
      const formData = new FormData();
      formData.append('file', file);

      if (metadata?.appPackageName) {
        formData.append('metadata', JSON.stringify({ appPackageName: metadata.appPackageName }));
      }

      const response = await axios.post('/api/dev/images/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      return response.data;
    },

    /**
     * Replace an existing image
     * @param imageId - The ID of the image to replace
     * @param file - The new image file
     * @returns The new Cloudflare image URL
     */
    replace: async (imageId: string, file: File): Promise<{ url: string; imageId: string }> => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('replaceImageId', imageId);

      const response = await axios.post('/api/dev/images/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      return response.data;
    },

    /**
     * Delete an image from Cloudflare Images
     * @param imageId - The ID of the image to delete
     */
    delete: async (imageId: string): Promise<void> => {
      await axios.delete(`/api/dev/images/${imageId}`);
    },
  },

  // Installation sharing endpoints
  sharing: {
    // Get a shareable installation link for a TPA
    getInstallLink: async (packageName: string, orgId?: string): Promise<string> => {
      const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
      const response = await axios.get(`/api/dev/apps/${packageName}/share`, config);
      return response.data.installUrl;
    },

    // Track that a TPA has been shared with a specific email
    trackSharing: async (packageName: string, emails: string[], orgId?: string): Promise<void> => {
      const config = orgId ? { headers: { 'x-org-id': orgId } } : undefined;
      await axios.post(`/api/dev/apps/${packageName}/share`, { emails }, config);
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