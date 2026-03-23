/**
 * @fileoverview PhotoManager manages photo capture requests within a user session.
 * It adapts logic previously in a global photo-request.service.ts.
 */

import {
  CloudToGlassesMessageType,
  GlassesToCloudMessageType,
  PhotoResponse, // SDK type from Glasses
  PhotoRequest, // SDK type for App's request
  PhotoErrorCode,
  // Define AppPhotoResult in SDK or use a generic message structure
} from "@mentra/sdk";
import { Logger } from "pino";
import UserSession from "./UserSession";
import { ConnectionValidator } from "../validators/ConnectionValidator";

// Timeout handling is managed by CameraModule in the SDK

/**
 * Internal representation of a pending photo request,
 * adapted from PendingPhotoRequest in photo-request.service.ts.
 */
interface PendingPhotoRequest {
  requestId: string;
  userId: string; // From UserSession
  timestamp: number;
  // origin: 'app'; // All requests via PhotoManager are App initiated for now
  packageName: string; // Renamed from appId for consistency with App messages
  saveToGallery: boolean;
}

/**
 * Defines the structure of the photo result message sent to the App.
 * This should align with an SDK type (e.g., CloudToAppMessageType.PHOTO_RESULT_DATA).
 */
// export interface AppPhotoResultPayload { // This is the payload part
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
    this.logger = userSession.logger.child({ service: "PhotoManager" });
    this.logger.info("PhotoManager initialized");
  }

  /**
   * Handles a App's request to take a photo.
   * Adapts logic from photoRequestService.createAppPhotoRequest.
   */
  async requestPhoto(appRequest: PhotoRequest): Promise<string> {
    const {
      packageName,
      requestId,
      saveToGallery = false,
      customWebhookUrl,
      authToken,
      size = "medium",
      compress = "none",
    } = appRequest;

    this.logger.info(
      {
        packageName,
        requestId,
        saveToGallery,
        size,
        hasCustomWebhook: !!customWebhookUrl,
        hasAuthToken: !!authToken,
      },
      "Processing App photo request.",
    );

    // Get the webhook URL - use custom if provided, otherwise fall back to app's default
    let webhookUrl: string | undefined;
    if (customWebhookUrl) {
      webhookUrl = customWebhookUrl;
      this.logger.info(
        { requestId, customWebhookUrl, hasAuthToken: !!authToken },
        "Using custom webhook URL for photo request.",
      );
    } else {
      const app = this.userSession.installedApps.get(packageName);
      webhookUrl = app?.publicUrl ? `${app.publicUrl}/photo-upload` : undefined;
      this.logger.info({ requestId, defaultWebhookUrl: webhookUrl }, "Using default webhook URL for photo request.");
    }

    // Validate connections before processing photo request
    const validation = ConnectionValidator.validateForHardwareRequest(this.userSession, "photo");

    if (!validation.valid) {
      this.logger.error(
        {
          error: validation.error,
          errorCode: validation.errorCode,
          connectionStatus: ConnectionValidator.getConnectionStatus(this.userSession),
        },
        "Photo request validation failed",
      );

      throw new Error(validation.error || "Connection validation failed");
    }

    const requestInfo: PendingPhotoRequest = {
      requestId,
      userId: this.userSession.userId,
      timestamp: Date.now(),
      packageName,
      saveToGallery,
    };
    this.pendingPhotoRequests.set(requestId, requestInfo);

    // Flash is always on (privacy indicator for bystanders), sound is app-controlled via SDK
    const flash = true;
    const sound = appRequest.sound ?? true;

    // Message to glasses based on CloudToGlassesMessageType.PHOTO_REQUEST
    // Include webhook URL so ASG can upload directly to the app
    const messageToGlasses = {
      type: CloudToGlassesMessageType.PHOTO_REQUEST,
      sessionId: this.userSession.sessionId,
      requestId,
      appId: packageName, // Glasses expect `appId`
      webhookUrl, // Use custom webhookUrl if provided, otherwise default
      authToken, // Include authToken for webhook authentication
      size, // Propagate desired size
      compress, // Propagate compression setting
      flash, // Controls privacy flash LED (cloud-controlled)
      sound, // Controls shutter sound (app-controllable via SDK)
      timestamp: new Date(),
    };

    try {
      this.userSession.websocket.send(JSON.stringify(messageToGlasses));
      this.logger.info(
        {
          requestId,
          packageName,
          webhookUrl,
          isCustom: !!customWebhookUrl,
          hasAuthToken: !!authToken,
          flash,
          sound,
        },
        `PHOTO_REQUEST command sent to glasses (flash=${flash}, sound=${sound}).`,
      );

      // If using custom webhook URL, resolve immediately since glasses won't send response back to cloud
      if (customWebhookUrl) {
        this.logger.info(
          { requestId },
          "Using custom webhook URL - resolving promise immediately since glasses will upload directly to custom endpoint.",
        );
        this.pendingPhotoRequests.delete(requestId);

        // Send a success response to the app immediately
        await this._sendPhotoResultToApp(requestInfo, {
          type: GlassesToCloudMessageType.PHOTO_RESPONSE,
          requestId,
          success: true,
          photoUrl: customWebhookUrl, // Use the custom webhook URL as the photo URL
          savedToGallery: saveToGallery,
          timestamp: new Date(),
        });
      }
    } catch (error) {
      this.logger.error({ error, requestId }, "Failed to send PHOTO_REQUEST to glasses.");
      this.pendingPhotoRequests.delete(requestId);
      throw error;
    }
    return requestId;
  }

  /**
   * Handles a validated photo response.
   *
   * Callers (the REST endpoint) are responsible for validation and
   * building a well-formed PhotoResponse before calling this method.
   */
  async handlePhotoResponse(response: PhotoResponse): Promise<void> {
    const { requestId, success } = response;
    const pendingPhotoRequest = this.pendingPhotoRequests.get(requestId);

    this.logger.debug(
      {
        pendingPhotoRequests: Array.from(this.pendingPhotoRequests.keys()),
        response,
        success,
        requestId,
      },
      "Photo response processing debug info",
    );

    if (!pendingPhotoRequest) {
      this.logger.warn(
        { requestId, response },
        "Received photo response for unknown, timed-out, or already processed request.",
      );
      return;
    }

    this.logger.info(
      {
        requestId,
        packageName: pendingPhotoRequest.packageName,
        success,
        hasError: !success && !!response.error,
        errorCode: response.error?.code,
      },
      "Photo response received from glasses.",
    );
    this.pendingPhotoRequests.delete(requestId);

    if (success) {
      await this._sendPhotoResultToApp(pendingPhotoRequest, response);
    } else {
      await this._sendPhotoErrorToApp(pendingPhotoRequest, response);
    }
  }

  // Timeout handling removed - now managed by CameraModule in the SDK

  private async _sendPhotoErrorToApp(
    pendingPhotoRequest: PendingPhotoRequest,
    errorResponse: PhotoResponse,
  ): Promise<void> {
    const { requestId, packageName } = pendingPhotoRequest;

    try {
      // Use centralized messaging with automatic resurrection
      const result = await this.userSession.appManager.sendMessageToApp(packageName, errorResponse);

      if (result.sent) {
        this.logger.info(
          {
            requestId,
            packageName,
            errorCode: errorResponse.error?.code,
            resurrectionTriggered: result.resurrectionTriggered,
          },
          `Sent photo error to App ${packageName}${result.resurrectionTriggered ? " after resurrection" : ""}`,
        );
      } else {
        this.logger.warn(
          {
            requestId,
            packageName,
            errorCode: errorResponse.error?.code,
            resurrectionTriggered: result.resurrectionTriggered,
            error: result.error,
          },
          `Failed to send photo error to App ${packageName}`,
        );
      }
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          packageName,
          errorCode: errorResponse.error?.code,
        },
        `Error sending photo error to App ${packageName}`,
      );
    }
  }

  private async _sendPhotoResultToApp(
    pendingPhotoRequest: PendingPhotoRequest,
    photoResponse: PhotoResponse,
  ): Promise<void> {
    const { requestId, packageName } = pendingPhotoRequest;

    try {
      // Use centralized messaging with automatic resurrection
      const result = await this.userSession.appManager.sendMessageToApp(packageName, photoResponse);

      if (result.sent) {
        this.logger.info(
          {
            requestId,
            packageName,
            resurrectionTriggered: result.resurrectionTriggered,
          },
          `Sent photo result to App ${packageName}${result.resurrectionTriggered ? " after resurrection" : ""}`,
        );
      } else {
        this.logger.warn(
          {
            requestId,
            packageName,
            resurrectionTriggered: result.resurrectionTriggered,
            error: result.error,
          },
          `Failed to send photo result to App ${packageName}`,
        );
      }
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          packageName,
        },
        `Error sending photo result to App ${packageName}`,
      );
    }
  }

  /**
   * Called when the UserSession is ending.
   */
  dispose(): void {
    this.logger.info("Disposing PhotoManager, cancelling pending photo requests for this session.");
    // Timeout handling removed - CameraModule manages timeouts
    this.pendingPhotoRequests.clear();
  }
}

export default PhotoManager;
