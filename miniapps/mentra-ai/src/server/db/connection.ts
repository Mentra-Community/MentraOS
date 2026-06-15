/**
 * MongoDB Connection Manager
 *
 * Handles database connection lifecycle using Mongoose.
 */

import mongoose from 'mongoose';

let isConnected = false;

/**
 * Connect to MongoDB
 * @throws Error if MONGODB_URI is not set
 */
export async function connectDB(): Promise<void> {
  if (isConnected) {
    console.log('📦 Already connected to MongoDB');
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('⚠️ MONGODB_URI not set, skipping database connection');
    return;
  }

  try {
    await mongoose.connect(uri);
    isConnected = true;
    console.log('📦 Connected to MongoDB');
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    throw error;
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectDB(): Promise<void> {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    console.log('📦 Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Failed to disconnect from MongoDB:', error);
    throw error;
  }
}

/**
 * Check if database is connected
 */
export function isDBConnected(): boolean {
  return isConnected;
}
