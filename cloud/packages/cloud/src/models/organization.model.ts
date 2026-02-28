/**
 * @fileoverview Organization model - defines schema for organizations that group users
 * and own applications (Apps). Users can be members of multiple organizations.
 */

import mongoose, { Schema, model, Document, Types, Model } from "mongoose";

/**
 * Interface representing a member of an organization
 */
export interface OrgMember {
  /** Reference to user document */
  user: Types.ObjectId;
  /** Role of user in organization */
  role: "admin" | "member";
  /** Date when user joined the organization */
  joinedAt: Date;
}

/**
 * Interface representing a pending invitation
 */
export interface PendingInvite {
  /** Email address of the invitee */
  email: string;
  /** Role to assign when invitation is accepted */
  role: "admin" | "member";
  /** JWT token for accepting the invitation */
  token: string;
  /** User who sent the invitation */
  invitedBy: Types.ObjectId;
  /** Date when invitation was sent */
  invitedAt: Date;
  /** Date when invitation expires */
  expiresAt: Date;
  /** Number of times invitation email was sent */
  emailSentCount: number;
  /** Last time invitation email was sent */
  lastEmailSentAt?: Date;
}

/**
 * Interface for Organization document in MongoDB
 */
export interface OrganizationI extends Document {
  /** Organization name, displayed in UI */
  name: string;
  /** URL-safe unique identifier for organization */
  slug: string;
  /** Profile information shown in App Store */
  profile: {
    /** Organization website URL */
    website?: string;
    /** Required contact email for App Store publishing */
    contactEmail: string;
    /** Description of the organization */
    description?: string;
    /** URL to organization logo */
    logo?: string;
  };
  /** List of organization members with their roles */
  members: OrgMember[];
  /** List of pending invitations */
  pendingInvites: PendingInvite[];
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Mongoose schema for Organizations
 */
const OrganizationSchema = new Schema<OrganizationI>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: (slug: string) => /^[a-z0-9-]+$/.test(slug),
        message:
          "Slug must contain only lowercase letters, numbers, and hyphens",
      },
    },
    profile: {
      website: {
        type: String,
        trim: true,
        validate: {
          validator: (url: string) => !url || /^https?:\/\//.test(url),
          message:
            "Website must be a valid URL starting with http:// or https://",
        },
      },
      contactEmail: {
        type: String,
        required: true,
        trim: true,
        validate: {
          validator: (email: string) =>
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
          message: "Contact email must be a valid email address",
        },
      },
      description: {
        type: String,
        trim: true,
      },
      logo: {
        type: String,
        trim: true,
      },
    },
    members: [
      {
        user: {
          type: Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        role: {
          type: String,
          enum: ["admin", "member"],
          default: "member",
        },
        joinedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    pendingInvites: [
      {
        email: {
          type: String,
          required: true,
          trim: true,
          lowercase: true,
          validate: {
            validator: (email: string) =>
              /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
            message: "Email must be a valid email address",
          },
        },
        role: {
          type: String,
          enum: ["admin", "member"],
          required: true,
        },
        token: {
          type: String,
          required: true,
        },
        invitedBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        invitedAt: {
          type: Date,
          default: Date.now,
        },
        expiresAt: {
          type: Date,
          required: true,
        },
        emailSentCount: {
          type: Number,
          default: 1,
        },
        lastEmailSentAt: {
          type: Date,
        },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Create indexes for efficient queries
OrganizationSchema.index({ slug: 1 }, { unique: true });
OrganizationSchema.index({ "members.user": 1 });
OrganizationSchema.index({ createdAt: 1 });

// Methods to standardize frequently used operations

/**
 * Generates a URL-safe slug from organization name
 */
OrganizationSchema.statics.generateSlug = function (name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
};

/**
 * Find organizations where a user is a member
 */
OrganizationSchema.statics.findByMember = async function (
  userId: Types.ObjectId,
): Promise<OrganizationI[]> {
  return this.find({ "members.user": userId });
};

/**
 * Check if user is a member of an organization
 */
OrganizationSchema.statics.isMember = async function (
  orgId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
): Promise<boolean> {
  const count = await this.countDocuments({
    _id: orgId,
    "members.user": userId,
  });
  return count > 0;
};

/**
 * Check if user has a specific role in an organization
 */
OrganizationSchema.statics.hasRole = async function (
  orgId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  roles: string | string[],
): Promise<boolean> {
  const roleArray = Array.isArray(roles) ? roles : [roles];
  const count = await this.countDocuments({
    _id: orgId,
    members: {
      $elemMatch: {
        user: userId,
        role: { $in: roleArray },
      },
    },
  });
  return count > 0;
};

// Define interface for static methods
interface OrganizationModel extends Model<OrganizationI> {
  generateSlug(name: string): string;
  findByMember(userId: Types.ObjectId): Promise<OrganizationI[]>;
  isMember(
    orgId: Types.ObjectId | string,
    userId: Types.ObjectId | string,
  ): Promise<boolean>;
  hasRole(
    orgId: Types.ObjectId | string,
    userId: Types.ObjectId | string,
    roles: string | string[],
  ): Promise<boolean>;
}

// Create and export the model
export const Organization = (mongoose.models.Organization ||
  model<OrganizationI, OrganizationModel>(
    "Organization",
    OrganizationSchema,
  )) as OrganizationModel;

export default Organization;
