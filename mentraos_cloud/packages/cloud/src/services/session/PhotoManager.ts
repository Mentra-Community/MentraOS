/**
 * @fileoverview PhotoManager manages photo capture requests within a user session.
 * It adapts logic previously in a global photo-request.service.ts.
 */

import WebSocket from 'ws';
import crypto from 'crypto'; // Changed from uuidv4 to crypto.randomUUID for consistency
import {
  CloudToGlassesMessageType,
  CloudToTpaMessageType,
  PhotoResponse, // SDK type from Glasses
  PhotoRequest, // SDK type for TPA's request
  CloudToTpaMessage,
  // Define TpaPhotoResult in SDK or use a generic message structure
} from '@augmentos/sdk';
import { Logger } from 'pino';
import UserSession from './UserSession';

const PHOTO_REQUEST_TIMEOUT_MS_DEFAULT = 30000; // Default timeout for photo requests

/**
 * Internal representation of a pending photo request,
 * adapted from PendingPhotoRequest in photo-request.service.ts.
 */
interface PendingPhotoRequest {
  requestId: string;
  userId: string; // From UserSession
  timestamp: number;
  // origin: 'tpa'; // All requests via PhotoManager are TPA initiated for now
  packageName: string;    // Renamed from appId for consistency with TPA messages
  tpaWebSocket?: WebSocket; // WebSocket connection for the TPA (optional since centralized messaging handles this)
  saveToGallery: boolean;
  timeoutId: NodeJS.Timeout;
}

/**
 * Defines the structure of the photo result message sent to the TPA.
 * This should align with an SDK type (e.g., CloudToTpaMessageType.PHOTO_RESULT_DATA).
 */
// export interface TpaPhotoResultPayload { // This is the payload part
//   requestId: string;
//   success: boolean;
//   photoUrl?: string;
//   error?: string;
//   savedToGallery?: boolean;
//   // metadata from glasses if available?
// }


export class PhotoManager {
  private userSession: UserSession;
  private logger: Logger;
  private pendingPhotoRequests: Map<string, PendingPhotoRequest> = new Map(); // requestId -> info

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: 'PhotoManager' });
    this.logger.info('PhotoManager initialized');
  }

  /**
   * Handles a TPA's request to take a photo.
   * Adapts logic from photoRequestService.createTpaPhotoRequest.
   */
  async requestPhoto(tpaRequest: PhotoRequest): Promise<string> {
    const { packageName, saveToGallery = false } = tpaRequest; // Default saveToGallery if not provided by TPA

    this.logger.info({ packageName, saveToGallery }, 'Processing TPA photo request.');

    // Get TPA websocket for storing in pending request (but don't validate connection - 
    // centralized messaging will handle resurrection when we send the response)
    const tpaWebSocket = this.userSession.appWebsockets.get(packageName);

    if (!this.userSession.websocket || this.userSession.websocket.readyState !== WebSocket.OPEN) {
      this.logger.error('Glasses WebSocket not connected, cannot send photo request to glasses.');
      throw new Error('Glasses WebSocket not connected.');
    }

    const requestId = crypto.randomUUID();

    const requestInfo: PendingPhotoRequest = {
      requestId,
      userId: this.userSession.userId,
      timestamp: Date.now(),
      packageName,
      tpaWebSocket,
      saveToGallery, // This is what we'll tell glasses if it supports it, or use in response
      timeoutId: setTimeout(() => this._handlePhotoRequestTimeout(requestId), PHOTO_REQUEST_TIMEOUT_MS_DEFAULT),
    };
    this.pendingPhotoRequests.set(requestId, requestInfo);

    // Message to glasses based on CloudToGlassesMessageType.PHOTO_REQUEST
    // SDK doesn't show a specific PhotoRequestToGlasses type, but implies structure.
    const messageToGlasses = {
      type: CloudToGlassesMessageType.PHOTO_REQUEST,
      sessionId: this.userSession.sessionId,
      requestId,
      appId: packageName, // Glasses expect `appId`
      // Note: `saveToGallery` is part of GlassesPhotoResponseSDK, not typically in request *to* glasses.
      // If glasses API *can* take this as an instruction, add it. Otherwise, it's cloud-enforced metadata.
      // For now, assume glasses don't take saveToGallery in request. We use it when forming TPA response.
      timestamp: new Date(),
    };

    try {
      this.userSession.websocket.send(JSON.stringify(messageToGlasses));
      this.logger.info({ requestId, packageName }, 'PHOTO_REQUEST command sent to glasses.');
    } catch (error) {
      this.logger.error({ error, requestId }, 'Failed to send PHOTO_REQUEST to glasses.');
      clearTimeout(requestInfo.timeoutId);
      this.pendingPhotoRequests.delete(requestId);
      // No need to send error to TPA here, as the promise rejection will be caught by caller in websocket-tpa.service
      throw error;
    }
    return requestId; // Return requestId so TPA can correlate if needed (though response will have it)
  }

  /**
   * Handles a photo response from glasses.
   * Adapts logic from photoRequestService.processPhotoResponse.
   */
  async handlePhotoResponse(glassesResponse: PhotoResponse): Promise<void> {
    const { requestId, photoUrl, savedToGallery } = glassesResponse; // `savedToGallery` from glasses confirms actual status
    const pendingPhotoRequest = this.pendingPhotoRequests.get(requestId);

    if (!pendingPhotoRequest) {
      this.logger.warn({ requestId, glassesResponse }, 'Received photo response for unknown, timed-out, or already processed request.');
      return;
    }

    this.logger.info({ requestId, packageName: pendingPhotoRequest.packageName, glassesResponse }, 'Photo response received from glasses.');
    clearTimeout(pendingPhotoRequest.timeoutId);
    this.pendingPhotoRequests.delete(requestId);

    await this._sendPhotoResultToTpa(pendingPhotoRequest, glassesResponse);
  }

  private _handlePhotoRequestTimeout(requestId: string): void {
    const requestInfo = this.pendingPhotoRequests.get(requestId);
    if (!requestInfo) return; // Already handled or cleared

    this.logger.warn({ requestId, packageName: requestInfo.packageName }, 'Photo request timed out.');
    this.pendingPhotoRequests.delete(requestId); // Remove before sending error

    // this._sendPhotoResultToTpa(requestInfo, {
    //   success: false,
    //   error: 'Photo request timed out waiting for glasses response.',
    //   savedToGallery: requestInfo.saveToGallery // Reflect intended, though failed
    // });
    // Instead of sending a result, we throw an error to the TPA.

  }

  private async _sendPhotoResultToTpa(
    pendingPhotoRequest: PendingPhotoRequest,
    photoResponse: PhotoResponse
  ): Promise<void> {
    const { requestId, packageName } = pendingPhotoRequest;

    try {
      // Use centralized messaging with automatic resurrection
      const result = await this.userSession.appManager.sendMessageToTpa(packageName, photoResponse);
      
      if (result.sent) {
        this.logger.info({ 
          requestId, 
          packageName,
          resurrectionTriggered: result.resurrectionTriggered 
        }, `Sent photo result to TPA ${packageName}${result.resurrectionTriggered ? ' after resurrection' : ''}`);
      } else {
        this.logger.warn({ 
          requestId, 
          packageName,
          resurrectionTriggered: result.resurrectionTriggered,
          error: result.error
        }, `Failed to send photo result to TPA ${packageName}`);
      }
    } catch (error) {
      this.logger.error({ 
        error: error instanceof Error ? error.message : String(error),
        requestId, 
        packageName 
      }, `Error sending photo result to TPA ${packageName}`);
    }
  }

  /**
   * Called when the UserSession is ending.
   */
  dispose(): void {
    this.logger.info('Disposing PhotoManager, cancelling pending photo requests for this session.');
    this.pendingPhotoRequests.forEach((requestInfo, requestId) => {
      clearTimeout(requestInfo.timeoutId);
      // TODO(isaiah): We should extend the photo result to support error, so dev's can more gracefully handle failed photo requets.
      // this._sendPhotoResultToTpa(requestInfo, {
      //   error: 'User session ended; photo request cancelled.',
      //   savedToGallery: requestInfo.saveToGallery
      // });
    });
    this.pendingPhotoRequests.clear();
  }
}

export default PhotoManager;