/**
 * @fileoverview Hardware Capability Profiles
 *
 * Static capability definitions for all supported smart glasses models.
 * These profiles define the hardware and software features available
 * on each device model.
 */

// Model capability imports
import { evenRealitiesG1 } from './capabilities/even-realities-g1';
import { mentraLive } from './capabilities/mentra-live';
import { vuzixZ100 } from './capabilities/vuzix-z100';
import { Capabilities } from '@augmentos/sdk';

/**
 * Hardware capability profiles for supported glasses models
 * Key: model_name string (e.g., "Even Realities G1", "Mentra Live")
 * Value: Capabilities object defining device features
 */
export const HARDWARE_CAPABILITIES: Record<string, Capabilities> = {
  [evenRealitiesG1.modelName]: evenRealitiesG1,
  [mentraLive.modelName]: mentraLive,
  [vuzixZ100.modelName]: vuzixZ100,
};

/**
 * Get capability profile for a given model name
 * @param modelName - The model name of the glasses
 * @returns Capabilities object or null if model not found
 */
export function getCapabilitiesForModel(modelName: string): Capabilities | null {
  return HARDWARE_CAPABILITIES[modelName] || null;
}

/**
 * Get list of all supported model names
 * @returns Array of supported model names
 */
export function getSupportedModels(): string[] {
  return Object.keys(HARDWARE_CAPABILITIES);
}

/**
 * Check if a model is supported
 * @param modelName - The model name to check
 * @returns True if model is supported, false otherwise
 */
export function isModelSupported(modelName: string): boolean {
  return modelName in HARDWARE_CAPABILITIES;
}