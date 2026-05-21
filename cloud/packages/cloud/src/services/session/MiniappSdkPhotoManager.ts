/**
 * @fileoverview MiniappSdkPhotoManager — handles camera SDK photo requests
 * from local miniapps (takePhoto() on @mentra/miniapp camera module).
 *
 * Parallel to PhotoManager (cloud-SDK photos) but scoped to phone-initiated
 * requests via the __phone__ subscriber. The phone sends a REST request to
 * mint a signed upload URL, cloud sends PHOTO_REQUEST to glasses with that URL,
 * glasses (or BLE fallback through the phone's BlePhotoUploadService) upload
 * to the cloud endpoint, cloud writes the photo to a private R2 bucket, mints
 * a short-TTL signed download URL, and notifies the phone via phone_photo_ready
 * over the existing client WebSocket.
 *
 * Owned by UserSession, not by PhoneSession — this manager needs direct access
 * to userSession.websocket for sending PHOTO_REQUEST to glasses and
 * phone_photo_ready back to the phone.
 */

import { Logger } from "pino";
import jwt from "jsonwebtoken";

import { CloudToGlassesMessageType } from "@mentra/sdk";

import { ConnectionValidator } from "../validators/ConnectionValidator";
import UserSession from "./UserSession";

const MINIAPP_SDK_PHOTO_UPLOAD_SECRET =
  process.env.MINIAPP_SDK_PHOTO_UPLOAD_SECRET || "miniapp-sdk-photo-dev-secret";

const UPLOAD_TOKEN_TTL_SECONDS = 120; // 2 minutes
const REQUEST_TIMEOUT_MS = 30_000; // 30 seconds

interface PendingPhotoRequest {
  requestId: string;
  packageName: string;
  timestamp: number;
  uploadToken: string;
  timer: ReturnType<typeof setTimeout>;
}

export class MiniappSdkPhotoManager {
  private userSession: UserSession;
  private logger: Logger;
  private pendingRequests = new Map<string, PendingPhotoRequest>();

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "MiniappSdkPhotoManager" });
    this.logger.info("MiniappSdkPhotoManager initialized");
  }

  /**
   * Handle a photo request from a local miniapp (via REST endpoint).
   *
   * - Validates the glasses connection.
   * - Mints a signed upload URL + token.
   * - Sends PHOTO_REQUEST to glasses.
   * - Returns the requestId for the phone to track.
   */
  async requestPhoto(params: {
    requestId: string;
    packageName: string;
    size?: string;
    compress?: string;
    saveToGallery?: boolean;
    sound?: boolean;
  }): Promise<{ accepted: true; requestId: string }> {
    const { requestId, packageName, size = "medium", compress = "none", sound = true } = params;

    // Validate glasses connection
    const validation = ConnectionValidator.validateForHardwareRequest(this.userSession, "photo");
    if (!validation.valid) {
      throw new Error(validation.error || "Glasses not connected");
    }

    // Mint upload token (JWT scoped to this requestId)
    const uploadToken = jwt.sign(
      { requestId, userId: this.userSession.userId, purpose: "miniapp_sdk_photo_upload" },
      MINIAPP_SDK_PHOTO_UPLOAD_SECRET,
      { expiresIn: UPLOAD_TOKEN_TTL_SECONDS },
    );

    // Construct the upload URL
    const cloudHost = process.env.CLOUD_PUBLIC_HOST_NAME || "localhost:8002";
    const protocol = cloudHost.includes("localhost") ? "http" : "https";
    const uploadUrl = `${protocol}://${cloudHost}/api/client/miniapp-sdk-photo/upload/${requestId}`;

    // Register as pending
    const timer = setTimeout(() => {
      this.handleTimeout(requestId);
    }, REQUEST_TIMEOUT_MS);

    const pending: PendingPhotoRequest = {
      requestId,
      packageName,
      timestamp: Date.now(),
      uploadToken,
      timer,
    };
    this.pendingRequests.set(requestId, pending);

    // Send PHOTO_REQUEST to glasses (same wire format as cloud apps)
    const messageToGlasses = {
      type: CloudToGlassesMessageType.PHOTO_REQUEST,
      sessionId: this.userSession.sessionId,
      requestId,
      appId: packageName,
      webhookUrl: uploadUrl,
      authToken: uploadToken,
      size,
      compress,
      flash: true, // privacy indicator always on
      sound,
      timestamp: new Date(),
    };

    try {
      this.userSession.websocket.send(JSON.stringify(messageToGlasses));
      this.logger.info(
        { requestId, packageName, uploadUrl },
        "Sent PHOTO_REQUEST to glasses for miniapp SDK photo",
      );
    } catch (error) {
      this.pendingRequests.delete(requestId);
      clearTimeout(timer);
      throw error;
    }

    return { accepted: true, requestId };
  }

  /**
   * Called by the upload endpoint once the photo has been stored in R2 and
   * a signed download URL has been minted. Sends phone_photo_ready to the
   * phone client carrying the signed URL.
   */
  handleUploadComplete(requestId: string, photoUrl: string, mimeType: string, size: number): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.logger.warn({ requestId }, "Upload complete for unknown/expired request");
      return;
    }

    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    // Wire message type stays `phone_photo_ready` — it's the existing contract
    // with the mobile client. Only the storage destination (and URL shape) has
    // changed: photoUrl is now a short-TTL signed R2 URL instead of a public URL.
    const message = {
      type: "phone_photo_ready",
      requestId,
      photoUrl,
      mimeType,
      size,
      timestamp: new Date().toISOString(),
    };

    try {
      this.userSession.websocket.send(JSON.stringify(message));
      this.logger.info(
        { requestId, packageName: pending.packageName },
        "Sent phone_photo_ready to phone client",
      );
    } catch (error) {
      this.logger.error({ requestId, error }, "Failed to send phone_photo_ready");
    }
  }

  /**
   * Called by the upload endpoint when an error occurs during upload.
   */
  handleUploadError(requestId: string, errorCode: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    const message = {
      type: "phone_photo_ready",
      requestId,
      error: errorCode,
      timestamp: new Date().toISOString(),
    };

    try {
      this.userSession.websocket.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error({ requestId, error }, "Failed to send phone_photo_ready error");
    }
  }

  /**
   * Verify an upload token.
   */
  verifyUploadToken(token: string): { requestId: string; userId: string } | null {
    try {
      const decoded = jwt.verify(token, MINIAPP_SDK_PHOTO_UPLOAD_SECRET) as jwt.JwtPayload;
      if (decoded.purpose !== "miniapp_sdk_photo_upload") return null;
      return {
        requestId: decoded.requestId as string,
        userId: decoded.userId as string,
      };
    } catch {
      return null;
    }
  }

  private handleTimeout(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);
    this.logger.warn(
      { requestId, packageName: pending.packageName },
      "Miniapp SDK photo request timed out",
    );

    const message = {
      type: "phone_photo_ready",
      requestId,
      error: "TIMEOUT",
      timestamp: new Date().toISOString(),
    };

    try {
      this.userSession.websocket.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error({ requestId, error }, "Failed to send timeout notification");
    }
  }

  cleanup(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
  }
}
