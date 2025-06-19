// NOTE(isaiah): This file is deprecated and not used, any logic should be in services/session/PhotoManager.

import { logger as rootLogger } from "../logging";
// import { ExtendedUserSession } from "./session.service";
import { UserSession } from "../session/UserSession";
import { subscriptionService } from "../session/subscription.service";
import { StreamType, CloudToTpaMessageType } from "@augmentos/sdk";
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const logger = rootLogger.child({ service: 'photo-taken.service' });

/**
 * Service for handling photo taken subscriptions and broadcasting
 */
class PhotoTakenService {
  private getPhotoExtension(mimeType: string): string {
    const mimeToExt: { [key: string]: string } = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/heic': '.heic',
      'image/heif': '.heif'
    };
    return mimeToExt[mimeType] || '.jpg'; // Default to .jpg if mime type not recognized
  }

  // NOTE(isaiah): we should not be saving anything to disk ever. TODO(isaiah): Let's use cloudflare R2.
  private savePhoto(photoData: Buffer<ArrayBufferLike>, mimeType: string): string {
    const uploadDir = path.join(__dirname, '../../../uploads/photos');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = this.getPhotoExtension(mimeType);
    const filename = `${timestamp}_${uuidv4()}${extension}`;
    const filepath = path.join(uploadDir, filename);

    // Convert ArrayBuffer to Buffer and save
    const buffer = photoData;
    fs.writeFileSync(filepath, buffer);

    logger.info(`Photo saved to ${filepath}`);
    return filename;
  }

  /**
   * Broadcast a photo to all TPAs subscribed to PHOTO_TAKEN
   * @param userSession The user session
   * @param photoData The photo data as ArrayBuffer
   * @param mimeType The MIME type of the photo
   */
  broadcastPhotoTaken(userSession: UserSession, photoData: Buffer<ArrayBufferLike>, mimeType: string): void {
    // Get all TPAs subscribed to PHOTO_TAKEN
    const subscribedApps = subscriptionService.getSubscribedApps(userSession, StreamType.PHOTO_TAKEN);

    if (subscribedApps.length === 0) {
      logger.debug(`No TPAs subscribed to PHOTO_TAKEN for user ${userSession.userId}`);
      return;
    }

    logger.info(`Broadcasting photo to ${subscribedApps.length} TPAs for user ${userSession.userId}`);

    // Save the photo first
    const filename = this.savePhoto(photoData, mimeType);
    logger.info(`Photo saved as ${filename}`);

    // Convert ArrayBuffer to base64 string
    const base64Data = photoData.toString('base64');

    // Create the photo taken message
    const message = {
      type: CloudToTpaMessageType.DATA_STREAM,
      streamType: StreamType.PHOTO_TAKEN,
      data: {
        photoData: base64Data,
        mimeType,
        timestamp: new Date(),
        filename
      }
    };

    // Send to each subscribed TPA
    for (const packageName of subscribedApps) {
      const websocket = userSession.appWebsockets.get(packageName);
      if (websocket && websocket.readyState === 1) {
        websocket.send(JSON.stringify(message));
        logger.debug(`Sent photo to TPA ${packageName}`);
      } else {
        logger.warn(`TPA ${packageName} not connected or WebSocket not ready`);
      }
    }
  }
}

// Create and export a singleton instance
export const photoTakenService = new PhotoTakenService();
export default photoTakenService;
