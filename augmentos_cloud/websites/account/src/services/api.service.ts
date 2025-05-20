import axios from "axios";

// Set default config
axios.defaults.baseURL = import.meta.env.VITE_CLOUD_API_URL || "http://localhost:8002";
axios.defaults.withCredentials = true;

// User account interface
export interface UserAccount {
  id: string;
  email: string;
  name?: string;
  profile?: {
    displayName?: string;
    phoneNumber?: string;
    profilePicture?: string;
    preferences?: Record<string, any>;
  };
  createdAt: string;
}

// Export request interface
export interface ExportRequest {
  id: string;
  userId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  format: 'json' | 'csv';
  createdAt: string;
  completedAt?: string;
  downloadUrl?: string;
}

const api = {
  // Account management endpoints
  account: {
    // Get current user account information
    me: async (): Promise<UserAccount> => {
      const response = await axios.get("/api/account/me");
      return response.data;
    },
    
    // Update user profile
    updateProfile: async (profileData: unknown): Promise<UserAccount> => {
      const response = await axios.put("/api/account/profile", profileData);
      return response.data;
    },

    // Request account deletion
    requestDeletion: async (reason?: string): Promise<{ requestId: string }> => {
      const response = await axios.post("/api/account/request-deletion", { reason });
      return response.data;
    },

    // Confirm account deletion
    confirmDeletion: async (requestId: string, confirmationCode: string): Promise<void> => {
      await axios.delete("/api/account/confirm-deletion", { 
        data: { requestId, confirmationCode } 
      });
    },

    // Get privacy settings
    getPrivacySettings: async (): Promise<Record<string, boolean>> => {
      const response = await axios.get("/api/account/privacy");
      return response.data;
    },

    // Update privacy settings
    updatePrivacySettings: async (settings: Record<string, boolean>): Promise<Record<string, boolean>> => {
      const response = await axios.put("/api/account/privacy", settings);
      return response.data;
    },
  },

  // Data export endpoints
  export: {
    // Request data export
    requestExport: async (format: 'json' | 'csv' = 'json'): Promise<ExportRequest> => {
      const response = await axios.post("/api/account/request-export", { format });
      return response.data;
    },

    // Check export status
    getStatus: async (exportId: string): Promise<ExportRequest> => {
      const response = await axios.get(`/api/account/export-status?id=${exportId}`);
      return response.data;
    },

    // Get download URL
    getDownloadUrl: async (exportId: string): Promise<string> => {
      const response = await axios.get(`/api/account/download-export/${exportId}`);
      return response.data.downloadUrl;
    }
  }
};

export default api;