// src/webhook.ts

/**
 * Types of webhook requests that can be sent to TPAs
 */
export enum WebhookRequestType {
  /** Request to start a TPA session */
  SESSION_REQUEST = 'session_request',
  
  /** Request to stop a TPA session */
  STOP_REQUEST = 'stop_request',
  
  /** Server registration confirmation */
  SERVER_REGISTRATION = 'server_registration',
  
  /** Server heartbeat response */
  SERVER_HEARTBEAT = 'server_heartbeat',
  
  /** Session recovery request */
  SESSION_RECOVERY = 'session_recovery'
}
  
  /**
   * Base interface for all webhook requests
   */
  export interface BaseWebhookRequest {
    /** Type of webhook request */
    type: WebhookRequestType;
    
    /** Session ID for the request */
    sessionId: string;
    
    /** User ID associated with the session */
    userId: string;
    
    /** Timestamp of the request */
    timestamp: string;
  }
  
  /**
   * Session request webhook
   * 
   * Sent to a TPA when a user starts the TPA
   */
  export interface SessionWebhookRequest extends BaseWebhookRequest {
    type: WebhookRequestType.SESSION_REQUEST;
    augmentOSWebsocketUrl?: string;
  }

  /**
   * Stop request webhook
   * 
   * Sent to a TPA when a user or the system stops the TPA
   */
  export interface StopWebhookRequest extends BaseWebhookRequest {
    type: WebhookRequestType.STOP_REQUEST;
    reason: 'user_disabled' | 'system_stop' | 'error';
  }
  
  /**
   * Server registration webhook
   * 
   * Sent to a TPA when its server registration is confirmed
   */
  export interface ServerRegistrationWebhookRequest extends BaseWebhookRequest {
    type: WebhookRequestType.SERVER_REGISTRATION;
    registrationId: string;
    packageName: string;
    serverUrls: string[];
  }

  /**
   * Session recovery webhook
   * 
   * Sent to a TPA when the system is trying to recover a session after server restart
   */
  export interface SessionRecoveryWebhookRequest extends BaseWebhookRequest {
    type: WebhookRequestType.SESSION_RECOVERY;
    augmentOSWebsocketUrl: string;
  }

  /**
   * Server heartbeat webhook
   * 
   * Sent to a TPA to check its health status
   */
  export interface ServerHeartbeatWebhookRequest extends BaseWebhookRequest {
    type: WebhookRequestType.SERVER_HEARTBEAT;
    registrationId: string;
  }

  /**
   * Union type for all webhook requests
   */
  export type WebhookRequest = 
    | SessionWebhookRequest 
    | StopWebhookRequest
    | ServerRegistrationWebhookRequest
    | SessionRecoveryWebhookRequest
    | ServerHeartbeatWebhookRequest;
  
  /**
   * Response to a webhook request
   */
  export interface WebhookResponse {
    status: 'success' | 'error';
    message?: string;
  }
  
  /**
   * Type guard to check if a webhook request is a session request
   */
  export function isSessionWebhookRequest(request: WebhookRequest): request is SessionWebhookRequest {
    return request.type === WebhookRequestType.SESSION_REQUEST;
  }
  
  /**
   * Type guard to check if a webhook request is a stop request
   */
  export function isStopWebhookRequest(request: WebhookRequest): request is StopWebhookRequest {
    return request.type === WebhookRequestType.STOP_REQUEST;
  }
  
  /**
   * Type guard to check if a webhook request is a server registration request
   */
  export function isServerRegistrationWebhookRequest(
    request: WebhookRequest
  ): request is ServerRegistrationWebhookRequest {
    return request.type === WebhookRequestType.SERVER_REGISTRATION;
  }
  
  /**
   * Type guard to check if a webhook request is a session recovery request
   */
  export function isSessionRecoveryWebhookRequest(
    request: WebhookRequest
  ): request is SessionRecoveryWebhookRequest {
    return request.type === WebhookRequestType.SESSION_RECOVERY;
  }
  
  /**
   * Type guard to check if a webhook request is a server heartbeat request
   */
  export function isServerHeartbeatWebhookRequest(
    request: WebhookRequest
  ): request is ServerHeartbeatWebhookRequest {
    return request.type === WebhookRequestType.SERVER_HEARTBEAT;
  }