/**
 * Simple Storage Service for MentraOS Cloud (SDK Audience)
 *
 * Provides key-value storage operations scoped by user email and packageName.
 * Data is persisted in MongoDB using the SimpleStorage model, where each document
 * represents a storage namespace for a specific (email, packageName) pair.
 *
 * Notes:
 * - All values are stored as strings (Record<string, string>).
 * - Consumers should enforce authorization and package scoping before calling into this service.
 * - Value size limit: 100KB per value
 * - Total storage limit: 1MB per (email, packageName) combination
 *
 * Author: MentraOS Team
 */

import {
  SimpleStorage,
  SimpleStorageI,
} from "../../models/simple-storage.model";

// Constants
const MAX_VALUE_SIZE = 100_000; // 100KB
const MAX_TOTAL_SIZE = 1_000_000; // 1MB

/**
 * Calculate total storage size for a document
 */
function calculateStorageSize(data: Record<string, string>): number {
  return Object.values(data).reduce((sum, value) => sum + value.length, 0);
}

/**
 * Validate value size
 */
function validateValueSize(value: string, key?: string): void {
  if (value.length > MAX_VALUE_SIZE) {
    const keyMsg = key ? ` for key "${key}"` : "";
    throw new Error(
      `Value${keyMsg} exceeds 100KB limit (${value.length} bytes). ` +
        `Use your own S3 bucket storage for large files.`,
    );
  }
}

/**
 * Get the entire storage object for a given user and package.
 * Returns an empty object if no storage exists.
 */
export async function getAll(
  email: string,
  packageName: string,
): Promise<Record<string, string>> {
  const doc = await SimpleStorage.findOne({ email, packageName })
    .lean<SimpleStorageI>()
    .exec();
  return (doc?.data as Record<string, string>) ?? {};
}

/**
 * Get a single value by key for a given user and package.
 * Returns undefined if not found or storage does not exist.
 */
export async function getKey(
  email: string,
  packageName: string,
  key: string,
): Promise<string | undefined> {
  const doc = await SimpleStorage.findOne({ email, packageName })
    .lean<SimpleStorageI>()
    .exec();
  const storage = (doc?.data as Record<string, string>) ?? undefined;
  return storage ? storage[key] : undefined;
}

/**
 * Set a single key to a string value (upsert).
 * Creates the storage document if it does not exist.
 * Validates value size and total storage limits.
 */
export async function setKey(
  email: string,
  packageName: string,
  key: string,
  value: string,
): Promise<void> {
  // Validate value size
  validateValueSize(value, key);

  // Get current document
  const doc = await SimpleStorage.findOne({ email, packageName }).exec();
  const currentData = (doc?.data as Record<string, string>) || {};

  // Calculate new total size
  const currentSize = calculateStorageSize(currentData);
  const oldValueSize = currentData[key]?.length || 0;
  const newTotalSize = currentSize - oldValueSize + value.length;

  if (newTotalSize > MAX_TOTAL_SIZE) {
    throw new Error(
      `Total storage exceeds 1MB limit ` +
        `(current: ${currentSize}, new: ${newTotalSize}). ` +
        `Delete unused keys or use S3 storage.`,
    );
  }

  // Update
  await SimpleStorage.findOneAndUpdate(
    { email, packageName },
    { $set: { [`data.${key}`]: value } },
    { upsert: true, new: true },
  ).exec();
}

/**
 * Upsert multiple key/value pairs at once.
 * No-op when data is empty.
 * Validates each value size and total storage limit.
 */
export async function updateMany(
  email: string,
  packageName: string,
  data: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(data);
  if (entries.length === 0) return;

  // Validate each value size
  for (const [key, value] of entries) {
    validateValueSize(value, key);
  }

  // Get current document
  const doc = await SimpleStorage.findOne({ email, packageName }).exec();
  const currentData = (doc?.data as Record<string, string>) || {};

  // Calculate new total size
  const newData = { ...currentData, ...data };
  const newTotalSize = calculateStorageSize(newData);

  if (newTotalSize > MAX_TOTAL_SIZE) {
    const currentSize = calculateStorageSize(currentData);
    const addedSize = calculateStorageSize(data);
    throw new Error(
      `Total storage would exceed 1MB limit ` +
        `(current: ${currentSize}, adding: ${addedSize}, total: ${newTotalSize}). ` +
        `Delete unused keys or use S3 storage.`,
    );
  }

  // Update
  const setPayload: Record<string, string> = {};
  for (const [key, value] of entries) {
    setPayload[`data.${key}`] = value;
  }

  await SimpleStorage.findOneAndUpdate(
    { email, packageName },
    { $set: setPayload },
    { upsert: true, new: true },
  ).exec();
}

/**
 * Delete a single key for a given user and package.
 * Returns true if the storage document exists (regardless of whether the key existed),
 * false if the storage document does not exist.
 */
export async function deleteKey(
  email: string,
  packageName: string,
  key: string,
): Promise<boolean> {
  const result = await SimpleStorage.findOneAndUpdate(
    { email, packageName },
    { $unset: { [`data.${key}`]: 1 } },
    { new: true },
  ).exec();

  return !!result;
}

/**
 * Clear all keys for a given user and package (resets to an empty object).
 * Returns true if the storage document exists, false otherwise.
 */
export async function clearAll(
  email: string,
  packageName: string,
): Promise<boolean> {
  const result = await SimpleStorage.findOneAndUpdate(
    { email, packageName },
    { $set: { data: {} } },
    { new: true },
  ).exec();

  return !!result;
}
