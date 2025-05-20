/**
 * @fileoverview Service for managing photo requests from both system actions and TPAs.
 * 
 * This service centralizes the management of all photo requests to solve the issue where
 * system-initiated photo requests (via hardware button) and TPA-initiated photo requests
 * were tracked separately, causing upload validation failures.
 * 
 * Key features:
 * - Unified tracking of both system and TPA photo requests
 * - Consistent timeout handling
 * - Proper request cleanup
 * - Type safety with proper interfaces
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
// import { logger } from '@augmentos/utils';
import { logger as rootLogger } from "../logging";
const logger = rootLogger.child({ service: 'photo-request.service' });

/**
 * Types of photo request origins
 */
export type PhotoRequestOrigin = 'system' | 'tpa';

/**
 * Interface for a pending photo request
 */
export interface PendingPhotoRequest {
  requestId: string;       // Unique ID for this request
  userId: string;          // User ID who initiated the request
  timestamp: number;       // When the request was created
  origin: PhotoRequestOrigin; // Whether this is from system or TPA
  appId?: string;          // App ID (required for TPA requests, optional for system)
  ws?: WebSocket;          // WebSocket connection (only for TPA requests)
  saveToGallery: boolean;  // Whether to save to gallery (defaults true for system, configurable for TPA)
}

/**
 * Configuration options for photo requests
 */
export interface PhotoRequestConfig {
  // Timeout in milliseconds for photo requests (default: 30 seconds for TPA, 60 seconds for system)
  timeoutMs?: number;
  // Whether to save the photo to gallery (default: true for system, false for TPA)
  saveToGallery?: boolean;
}

/**
 * Response object when a photo is uploaded
 */
export interface PhotoResponse {
  requestId: string;
  photoUrl: string;
  savedToGallery: boolean;
}

/**
 * Service for managing photo requests
 */
class PhotoRequestService {
  // Unified map of all pending photo requests (system and TPA)
  private pendingPhotoRequests = new Map<string, PendingPhotoRequest>();
  
  // Default timeout values in milliseconds
  private readonly DEFAULT_TPA_TIMEOUT_MS = 30000; // 30 seconds
  private readonly DEFAULT_SYSTEM_TIMEOUT_MS = 60000; // 60 seconds
  
  constructor() {
    logger.info('✅ PhotoRequestService initialized');
  }
  
  /**
   * Create a new system-initiated photo request (e.g., from hardware button)
   * 
   * @param userId User ID who initiated the request
   * @param config Optional configuration options
   * @returns The request ID for the new photo request
   */
  createSystemPhotoRequest(userId: string, config?: PhotoRequestConfig): string {
    const requestId = uuidv4();
    const timestamp = Date.now();
    const timeoutMs = config?.timeoutMs || this.DEFAULT_SYSTEM_TIMEOUT_MS;
    const saveToGallery = config?.saveToGallery !== undefined ? config.saveToGallery : true;
    
    // Store the system photo request
    this.pendingPhotoRequests.set(requestId, {
      requestId,
      userId,
      timestamp,
      origin: 'system',
      saveToGallery
    });
    
    logger.info(`[PhotoRequestService] Created system photo request: ${requestId} for user ${userId}`);
    
    // Set timeout to clean up if not used
    this.setRequestTimeout(requestId, timeoutMs);
    
    return requestId;
  }
  
  /**
   * Create a new TPA-initiated photo request
   * 
   * @param userId User ID who initiated the request
   * @param appId App ID that requested the photo
   * @param ws WebSocket connection to send the response to
   * @param config Optional configuration options
   * @returns The request ID for the new photo request
   */
  createTpaPhotoRequest(
    userId: string, 
    appId: string, 
    ws: WebSocket,
    config?: PhotoRequestConfig
  ): string {
    const requestId = uuidv4();
    const timestamp = Date.now();
    const timeoutMs = config?.timeoutMs || this.DEFAULT_TPA_TIMEOUT_MS;
    const saveToGallery = config?.saveToGallery !== undefined ? config.saveToGallery : false;
    
    // Store the TPA photo request
    this.pendingPhotoRequests.set(requestId, {
      requestId,
      userId,
      timestamp,
      origin: 'tpa',
      appId,
      ws,
      saveToGallery
    });
    
    logger.info(`[PhotoRequestService] Created TPA photo request: ${requestId} for app ${appId}, user ${userId}`);
    
    // Set timeout to clean up if not used
    this.setRequestTimeout(requestId, timeoutMs);
    
    return requestId;
  }
  
  /**
   * Check if a photo request with the specified ID is pending
   * 
   * @param requestId The ID of the photo request to check
   * @returns True if a pending request with this ID exists, false otherwise
   */
  hasPendingPhotoRequest(requestId: string): boolean {
    return this.pendingPhotoRequests.has(requestId);
  }
  
  /**
   * Get the pending photo request with the given ID
   * 
   * @param requestId Request ID to look up
   * @returns The pending photo request, or undefined if not found
   */
  getPendingPhotoRequest(requestId: string): PendingPhotoRequest | undefined {
    return this.pendingPhotoRequests.get(requestId);
  }
  
  /**
   * Process a photo response by forwarding it to the requesting TPA (if applicable)
   * and cleaning up the request
   * 
   * @param requestId The ID of the photo request
   * @param photoUrl The URL of the uploaded photo
   * @returns True if the response was processed successfully, false otherwise
   */
  processPhotoResponse(requestId: string, photoUrl: string): boolean {
    // Find the pending request
    const pendingRequest = this.pendingPhotoRequests.get(requestId);
    
    if (!pendingRequest) {
      logger.warn(`[PhotoRequestService] No pending photo request found for requestId: ${requestId}`);
      return false;
    }
    
    // If this is a TPA request, forward the response via WebSocket
    if (pendingRequest.origin === 'tpa' && pendingRequest.ws) {
      // Check if the WebSocket is still open
      if (pendingRequest.ws.readyState !== WebSocket.OPEN) {
        logger.warn(`[PhotoRequestService] TPA WebSocket closed for requestId: ${requestId}`);
        this.pendingPhotoRequests.delete(requestId);
        return false;
      }
      
      // Send the photo response to the TPA
      const photoResponse = {
        type: 'photo_response',
        photoUrl,
        requestId,
        timestamp: new Date()
      };
      
      pendingRequest.ws.send(JSON.stringify(photoResponse));
      logger.info(`[PhotoRequestService] Photo response sent to TPA ${pendingRequest.appId}, requestId: ${requestId}`);
    } else if (pendingRequest.origin === 'system') {
      // For system requests, we don't need to forward anything, just log it
      logger.info(`[PhotoRequestService] System photo request completed: ${requestId}`);
    }
    
    // Clean up the pending request
    this.pendingPhotoRequests.delete(requestId);
    
    return true;
  }
  
  /**
   * Delete a photo request
   * 
   * @param requestId The ID of the photo request to delete
   * @returns True if the request was deleted, false if it wasn't found
   */
  deletePhotoRequest(requestId: string): boolean {
    const exists = this.pendingPhotoRequests.has(requestId);
    if (exists) {
      this.pendingPhotoRequests.delete(requestId);
      logger.info(`[PhotoRequestService] Deleted photo request: ${requestId}`);
    }
    return exists;
  }
  
  /**
   * Clean up expired photo requests
   * Primarily for internal use, but exposed for testing or manual cleanup
   */
  cleanupExpiredRequests(): void {
    const now = Date.now();
    let expiredCount = 0;
    
    // Check all requests for expiration
    for (const [requestId, request] of this.pendingPhotoRequests.entries()) {
      const age = now - request.timestamp;
      const timeout = request.origin === 'system' ? this.DEFAULT_SYSTEM_TIMEOUT_MS : this.DEFAULT_TPA_TIMEOUT_MS;
      
      if (age > timeout) {
        this.pendingPhotoRequests.delete(requestId);
        expiredCount++;
        
        logger.info(`[PhotoRequestService] Cleaned up expired ${request.origin} photo request: ${requestId}`);
      }
    }
    
    if (expiredCount > 0) {
      logger.info(`[PhotoRequestService] Cleaned up ${expiredCount} expired photo requests`);
    }
  }
  
  /**
   * Set a timeout to automatically clean up a request if not used
   * 
   * @param requestId The ID of the photo request
   * @param timeoutMs Timeout in milliseconds
   * @private
   */
  private setRequestTimeout(requestId: string, timeoutMs: number): void {
    setTimeout(() => {
      if (this.pendingPhotoRequests.has(requestId)) {
        const request = this.pendingPhotoRequests.get(requestId)!;
        logger.info(`[PhotoRequestService] Cleaned up expired ${request.origin} photo request: ${requestId}`);
        
        // If this is a TPA request with a WebSocket, send a timeout error
        if (request.origin === 'tpa' && request.ws && request.ws.readyState === WebSocket.OPEN) {
          const errorMessage = {
            type: 'connection_error',
            message: 'Photo request timed out',
            timestamp: new Date()
          };
          request.ws.send(JSON.stringify(errorMessage));
        }
        
        this.pendingPhotoRequests.delete(requestId);
      }
    }, timeoutMs);
  }
}

// Create and export a singleton instance
export const photoRequestService = new PhotoRequestService();
export default photoRequestService;