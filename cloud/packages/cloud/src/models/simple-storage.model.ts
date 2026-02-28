import mongoose, { Document } from "mongoose";

interface SimpleStorageI extends Document {
  email: string;
  packageName: string;
  data: Record<string, string>;
  // createdAt & updatedAt automatically added by timestamps: true
}

const simpleStorageSchema = new mongoose.Schema<SimpleStorageI>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    packageName: {
      type: String,
      required: true,
      trim: true,
    },
    data: {
      // Record object
      type: Object,
      of: String,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

simpleStorageSchema.index({ email: 1, packageName: 1 }, { unique: true });

const SimpleStorage = mongoose.model<SimpleStorageI>(
  "SimpleStorage",
  simpleStorageSchema,
);

export { SimpleStorage, SimpleStorageI };
export default SimpleStorage;
