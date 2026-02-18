/* eslint-disable @typescript-eslint/no-explicit-any */
// cloud/src/models/user-settings.model.ts
import mongoose, { Schema, Document } from "mongoose";
import { logger } from "../services/logging/pino-logger";
import { User } from "./user.model";

export interface UserSettingsI extends Document {
  email: string;
  settings: Record<string, any>;
  lastUpdated: Date;
  version: string;

  // Methods
  updateSettings(newSettings: Record<string, any>): Promise<void>;
  getSettings(): Record<string, any>;
  getSetting(key: string): any;
  setSetting(key: string, value: any): Promise<void>;
  deleteSetting(key: string): Promise<void>;
}

const UserSettingsSchema = new Schema<UserSettingsI>(
  {
    email: {
      type: String,
      ref: "User",
      required: true,
      unique: true, // enforces 1:1 relationship with User
      index: true,
      lowercase: true,
      trim: true,
    },

    settings: {
      type: Map,
      of: Schema.Types.Mixed,
      default: new Map(),
    },

    lastUpdated: {
      type: Date,
      default: Date.now,
    },

    version: {
      type: String,
      default: "1.0.0",
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        ret.id = ret._id;
        delete ret._id;

        // Convert Map to plain object for JSON
        if (ret.settings instanceof Map) {
          ret.settings = Object.fromEntries(ret.settings);
        }
        return ret;
      },
    },
  },
);

// Index for efficient queries
UserSettingsSchema.index({ email: 1, lastUpdated: -1 });

UserSettingsSchema.pre("save", function (next) {
  try {
    if (this.email && typeof this.email === "string") {
      this.email = this.email.toLowerCase().trim();
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_error) {
    // ignore
  }
  next();
});

// (removed legacy pre-save that mutated userId based on email)

// Instance Methods
UserSettingsSchema.methods.updateSettings = async function (
  this: UserSettingsI,
  newSettings: Record<string, any>,
): Promise<void> {
  // Merge new settings with existing
  for (const [key, value] of Object.entries(newSettings)) {
    if (value === null || value === undefined) {
      this.settings.delete(key);
    } else {
      this.settings.set(key, value);
    }
  }

  this.lastUpdated = new Date();
  await this.save();

  logger.debug(
    {
      userId: this.email,
      updatedKeys: Object.keys(newSettings),
    },
    `Settings updated for user ${this.email}`,
  );
};

UserSettingsSchema.methods.getSettings = function (
  this: UserSettingsI,
): Record<string, any> {
  return Object.fromEntries(this.settings.entries());
};

UserSettingsSchema.methods.getSetting = function (
  this: UserSettingsI,
  key: string,
): any {
  return this.settings.get(key);
};

UserSettingsSchema.methods.setSetting = async function (
  this: UserSettingsI,
  key: string,
  value: any,
): Promise<void> {
  if (value === null || value === undefined) {
    this.settings.delete(key);
  } else {
    this.settings.set(key, value);
  }

  this.lastUpdated = new Date();
  await this.save();
};

UserSettingsSchema.methods.deleteSetting = async function (
  this: UserSettingsI,
  key: string,
): Promise<void> {
  this.settings.delete(key);
  this.lastUpdated = new Date();
  await this.save();
};

export const UserSettings =
  mongoose.models.UserSettings ||
  mongoose.model<UserSettingsI>("UserSettings", UserSettingsSchema);

(async function migrateUserSettings() {
  const run = async () => {
    try {
      // Drop legacy unique index on userId if it exists
      try {
        const indexes = await UserSettings.collection.indexes();
        const userIdUnique = indexes.find(
          (ix: any) => ix.unique && ix.key && ix.key.userId === 1,
        );
        if (userIdUnique && userIdUnique.name) {
          try {
            await UserSettings.collection.dropIndex(userIdUnique.name);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) {
            // ignore
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        // ignore listing index errors
      }

      // Ensure partial unique index on email (only when email exists and non-empty)
      try {
        await UserSettings.collection.createIndex(
          { email: 1 },
          {
            unique: true,
            partialFilterExpression: { email: { $exists: true, $ne: "" } },
          },
        );

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        // ignore if exists or duplicates prevent creation
      }

      // Backfill email from userId where missing
      const BATCH = 200;
      const coll = mongoose.connection.db.collection("usersettings");
      while (true) {
        const docs = await coll
          .find({
            $or: [
              { email: { $exists: false } },
              { email: null },
              { email: "" },
            ],
            userId: { $exists: true, $ne: null },
          })
          .limit(BATCH)
          .toArray();

        if (!docs.length) break;

        for (const doc of docs) {
          try {
            const user = await User.findById(doc.userId);
            if (user && user.email) {
              const emailLower = String(user.email).toLowerCase().trim();
              await coll.updateOne(
                { _id: doc._id },
                { $set: { email: emailLower }, $unset: { userId: "" } },
              );
            }
          } catch {
            // ignore per-doc failures
          }
        }

        if (docs.length < BATCH) break;
      }

      // After backfill, remove legacy userId field wherever present
      try {
        await coll.updateMany(
          { userId: { $exists: true } },
          { $unset: { userId: "" } },
        );
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        // ignore
      }
      logger.info("UserSettings migration completed");
    } catch (err) {
      logger.error(err, "UserSettings migration error");
    }
  };

  if (mongoose.connection.readyState === 1) {
    setTimeout(run, 0);
  } else {
    mongoose.connection.on("connected", () => setTimeout(run, 0));
  }
})();
