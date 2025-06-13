// cloud/server/src/models/app.model.ts
import mongoose, { Schema, Document, Types } from 'mongoose';
import { AppI as _AppI, TpaType, ToolSchema, ToolParameterSchema, AppSetting, AppSettingType, PermissionType, Permission } from '@augmentos/sdk';

export type AppStoreStatus = 'DEVELOPMENT' | 'SUBMITTED' | 'REJECTED' | 'PUBLISHED';

// Extend the AppI interface for our MongoDB document
export interface AppI extends _AppI, Document {
  createdAt: Date;
  updatedAt: Date;
  isPublic: boolean;
  hashedApiKey: string;
  hashedEndpointSecret?: string;
  appStoreStatus: AppStoreStatus;
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  tools?: ToolSchema[];
  permissions?: Permission[];
  settings?: AppSetting[];

  /**
   * Reference to the organization that owns this app
   * @since 2.0.0
   */
  organizationId?: Types.ObjectId;

  /**
   * ID of the developer who created the app
   * @deprecated Use organizationId instead. Will be removed after migration.
   */
  developerId?: string;

  /**
   * Domain of the organization for app sharing
   * @deprecated Use organizationId instead. Will be removed after migration.
   */
  organizationDomain?: string | null;

  /**
   * Whether app is shared with the organization
   * @deprecated Use organizationId instead. Will be removed after migration.
   */
  sharedWithOrganization?: boolean;

  /**
   * App visibility setting
   * @deprecated Use organizationId instead. Will be removed after migration.
   */
  visibility?: 'private' | 'organization';

  /**
   * Specific emails the app is shared with
   * @deprecated Use organizationId with member management instead. Will be removed after migration.
   */
  sharedWithEmails?: string[];
}


// Using existing schema with flexible access
const AppSchema = new Schema({

  // Type of app "background" | "standard" | "system_dashboard". "background by default"
  tpaType: {
    type: String,
    enum: Object.values(TpaType),
    default: TpaType.BACKGROUND
  },

  // Appstore / Developer properties
  appStoreStatus: {
    type: String,
    enum: ['DEVELOPMENT', 'SUBMITTED', 'REJECTED', 'PUBLISHED'],
    default: 'DEVELOPMENT'
  },
  reviewNotes: {
    type: String,
    default: ''
  },
  reviewedBy: {
    type: String
  },
  reviewedAt: {
    type: Date
  },

  // TPA AI Tools
  tools: [{
    id: {
      type: String,
      required: true
    },
    description: {
      type: String,
      required: true
    },
    activationPhrases: {
      type: [String],
      required: false
    },
    parameters: {
      type: Map,
      of: new Schema({
        type: {
          type: String,
          enum: ['string', 'number', 'boolean'],
          required: true
        },
        description: {
          type: String,
          required: true
        },
        enum: {
          type: [String],
          required: false
        },
        required: {
          type: Boolean,
          default: false
        }
      }),
      required: false
    }
  }],

  // TPA Settings Configuration
  settings: [{
    type: {
      type: String,
      enum: Object.values(AppSettingType),
      required: true
    },
    key: {
      type: String,
      required: false
    },
    label: {
      type: String,
      required: false
    },
    title: {
      type: String,
      required: false
    },
    defaultValue: {
      type: Schema.Types.Mixed,
      required: false
    },
    value: {
      type: Schema.Types.Mixed,
      required: false
    },
    options: [{
      label: { type: String, required: true },
      value: { type: Schema.Types.Mixed, required: true }
    }],
    min: {
      type: Number,
      required: false
    },
    max: {
      type: Number,
      required: false
    },
    maxLines: {
      type: Number,
      required: false
    }
  }],

  // Add permissions array to schema
  permissions: [{
    type: {
      type: String,
      enum: Object.values(PermissionType),
      required: true
    },
    description: {
      type: String,
      required: false
    }
  }],

  /**
   * Reference to the organization that owns this app
   */
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    index: true,
    // not marking as required yet for backward compatibility during migration
  },

  // Deprecated fields - will be removed after migration
  developerId: {
    type: String,
    required: true // keeping as required for backward compatibility
  },
  organizationDomain: {
    type: String,
    required: false,
    default: null
  },
  sharedWithOrganization: {
    type: Boolean,
    required: false,
    default: false
  },
  visibility: {
    type: String,
    enum: ['private', 'organization'],
    default: 'private'
  },
  sharedWithEmails: {
    type: [String],
    required: false,
    default: []
  }
}, {
  strict: false,
  timestamps: true
});

// Add index for organizationId
AppSchema.index({ organizationId: 1 });

export default mongoose.models.App || mongoose.model<AppI>('App', AppSchema, 'apps');