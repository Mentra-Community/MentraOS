/**
 * test-displays.ts
 * 
 * Utility functions for creating test display requests.
 */

import { DisplayRequest, TpaToCloudMessageType, ViewType, LayoutType } from '@augmentos/sdk';

/**
 * Create a simple text display request
 */
export function createTextDisplay(
  packageName: string,
  text: string,
  options: {
    durationMs?: number;
    forceDisplay?: boolean;
    view?: ViewType;
  } = {}
): DisplayRequest {
  return {
    type: TpaToCloudMessageType.DISPLAY_REQUEST,
    packageName,
    view: options.view || ViewType.MAIN,
    layout: {
      layoutType: LayoutType.TEXT_WALL,
      text
    },
    timestamp: new Date(),
    durationMs: options.durationMs,
    forceDisplay: options.forceDisplay
  };
}

/**
 * Create a reference card display request
 */
export function createReferenceCard(
  packageName: string,
  title: string,
  text: string,
  options: {
    durationMs?: number;
    forceDisplay?: boolean;
    view?: ViewType;
  } = {}
): DisplayRequest {
  return {
    type: TpaToCloudMessageType.DISPLAY_REQUEST,
    packageName,
    view: options.view || ViewType.MAIN,
    layout: {
      layoutType: LayoutType.REFERENCE_CARD,
      title,
      text
    },
    timestamp: new Date(),
    durationMs: options.durationMs,
    forceDisplay: options.forceDisplay
  };
}

// Note: The above functions (createTextDisplay and createReferenceCard)
// are sufficient for testing and align with the actual SDK layout types.
// The command list and notification layout types were removed as they don't exist in the SDK.