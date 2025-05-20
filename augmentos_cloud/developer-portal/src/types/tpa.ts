import { TpaType } from '@augmentos/sdk';

// Define permission types
export enum PermissionType {
  MICROPHONE = 'MICROPHONE',
  LOCATION = 'LOCATION',
  CALENDAR = 'CALENDAR',
  NOTIFICATIONS = 'NOTIFICATIONS',
  ALL = 'ALL'
}

export interface Permission {
  type: PermissionType;
  description?: string;
}

export interface TPA {
  id: string;
  packageName: string;
  name: string;
  description: string;
  publicUrl: string;
  logoURL: string;
  webviewURL?: string;
  isPublic: boolean;
  appStoreStatus?: 'DEVELOPMENT' | 'SUBMITTED' | 'REJECTED' | 'PUBLISHED';
  tpaType: TpaType;
  createdAt?: string; // For compatibility with AppResponse
  updatedAt?: string; // For compatibility with AppResponse
  reviewNotes?: string; // Review notes from app review
  reviewedBy?: string; // Admin who reviewed the app
  reviewedAt?: string; // When the app was reviewed
  permissions?: Permission[]; // Permissions required by the app
}