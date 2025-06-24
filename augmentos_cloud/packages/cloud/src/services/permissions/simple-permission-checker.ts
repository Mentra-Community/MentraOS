import { PermissionType, LEGACY_PERMISSION_MAP } from '@mentra/sdk';
import { ExtendedStreamType, StreamType, isLanguageStream, parseLanguageStream } from '@mentra/sdk';
import { AppI } from '../../models/app.model';
import { logger } from '@mentra/utils';

/**
 * SimplePermissionChecker
 *
 * A lightweight service to check if apps have declared the necessary permissions
 * for the streams they're trying to subscribe to.
 */
export class SimplePermissionChecker {
  // Stream types to permission mapping
  private static STREAM_TO_PERMISSION_MAP = new Map<string, PermissionType>([
    // Audio-related streams
    [StreamType.AUDIO_CHUNK, PermissionType.MICROPHONE],
    [StreamType.TRANSCRIPTION, PermissionType.MICROPHONE],
    [StreamType.TRANSLATION, PermissionType.MICROPHONE],
    [StreamType.VAD, PermissionType.MICROPHONE],

    // Location stream
    [StreamType.LOCATION_UPDATE, PermissionType.LOCATION],

    // Calendar stream
    [StreamType.CALENDAR_EVENT, PermissionType.CALENDAR],

    // Notification streams
    [StreamType.PHONE_NOTIFICATION, PermissionType.READ_NOTIFICATIONS],
    [StreamType.NOTIFICATION_DISMISSED, PermissionType.READ_NOTIFICATIONS],
  ]);

  /**
   * Get the required permission for a stream type
   */
  static getRequiredPermissionForStream(streamType: ExtendedStreamType): PermissionType | null {
    // Handle language-specific streams
    if (isLanguageStream(streamType)) {
      const streamInfo = parseLanguageStream(streamType);
      if (streamInfo) {
        if (streamInfo.type === StreamType.TRANSCRIPTION ||
            streamInfo.type === StreamType.TRANSLATION) {
          return PermissionType.MICROPHONE;
        }
      }
    }

    // Check regular stream types
    return this.STREAM_TO_PERMISSION_MAP.get(streamType as string) || null;
  }

  /**
   * Check if an app has declared a specific permission (with legacy support)
   */
  static hasPermission(app: AppI, requiredPermission: PermissionType): boolean {
    // ALL permission is a special case that grants access to everything
    if (app.permissions?.some(p => p.type === PermissionType.ALL)) {
      return true;
    }

    // Direct permission match
    if (app.permissions?.some(p => p.type === requiredPermission)) {
      return true;
    }

    // Check for legacy permission mapping
    return this.hasLegacyPermission(app, requiredPermission);
  }

  /**
   * Check if app has legacy permission that covers the required permission
   */
  private static hasLegacyPermission(app: AppI, requiredPermission: PermissionType): boolean {
    if (!app.permissions) return false;

    // Check if any app permission is a legacy permission that maps to the required one
    for (const appPermission of app.permissions) {
      const mappedPermissions = LEGACY_PERMISSION_MAP.get(appPermission.type);
      if (mappedPermissions?.includes(requiredPermission)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Filter subscriptions based on declared permissions
   * Returns an object with allowed subscriptions and rejected ones with reasons
   */
  static filterSubscriptions(app: AppI, subscriptions: ExtendedStreamType[]): {
    allowed: ExtendedStreamType[];
    rejected: Array<{ stream: ExtendedStreamType; requiredPermission: PermissionType }>;
  } {
    const allowed: ExtendedStreamType[] = [];
    const rejected: Array<{ stream: ExtendedStreamType; requiredPermission: PermissionType }> = [];

    for (const subscription of subscriptions) {
      const requiredPermission = this.getRequiredPermissionForStream(subscription);

      // If no permission required or app has the permission, allow
      if (!requiredPermission || this.hasPermission(app, requiredPermission)) {
        allowed.push(subscription);
      } else {
        // Otherwise reject with reason
        rejected.push({
          stream: subscription,
          requiredPermission
        });
      }
    }

    // Log results
    if (rejected.length > 0) {
      logger.warn(
        `Filtered ${rejected.length} subscription(s) for app ${app.packageName} due to missing permissions: ` +
        rejected.map(r => `${r.stream} (requires ${r.requiredPermission})`).join(', ')
      );
    }

    return { allowed, rejected };
  }

  /**
   * Utility: Normalize legacy permissions to new format
   * This can be used for UI display or migration guidance
   */
  static normalizePermissions(permissions: any[]): any[] {
    const normalized: any[] = [];
    const seenPermissions = new Set<PermissionType>();

    for (const permission of permissions) {
      if (permission.type === PermissionType.NOTIFICATIONS) {
        // Replace legacy NOTIFICATIONS with READ_NOTIFICATIONS
        if (!seenPermissions.has(PermissionType.READ_NOTIFICATIONS)) {
          normalized.push({
            type: PermissionType.READ_NOTIFICATIONS,
            description: permission.description || 'Read phone notifications'
          });
          seenPermissions.add(PermissionType.READ_NOTIFICATIONS);
        }
      } else if (!seenPermissions.has(permission.type)) {
        normalized.push(permission);
        seenPermissions.add(permission.type);
      }
    }

    return normalized;
  }
}