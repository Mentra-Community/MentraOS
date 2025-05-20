import { PermissionType } from '@augmentos/sdk';
import { ExtendedStreamType, StreamType, isLanguageStream, parseLanguageStream } from '@augmentos/sdk';
import { AppI } from '../../models/app.model';
import { logger } from '@augmentos/utils';

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
    [StreamType.PHONE_NOTIFICATION, PermissionType.NOTIFICATIONS],
    [StreamType.NOTIFICATION_DISMISSED, PermissionType.NOTIFICATIONS],
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
   * Check if an app has declared a specific permission
   */
  static hasPermission(app: AppI, permission: PermissionType): boolean {
    // ALL permission is a special case that grants access to everything
    if (app.permissions?.some(p => p.type === PermissionType.ALL)) {
      return true;
    }
    
    return app.permissions?.some(p => p.type === permission) || false;
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
}