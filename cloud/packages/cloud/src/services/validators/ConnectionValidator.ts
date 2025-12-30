/**
 * Centralized connection validation for hardware requests
 * Validates that both phone and glasses are connected before allowing hardware operations
 */


import { logger } from "../logging/pino-logger";
import UserSession from "../session/UserSession";
import { WebSocketReadyState } from "../websocket/types";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: ConnectionErrorCode;
}

export enum ConnectionErrorCode {
  PHONE_DISCONNECTED = "PHONE_DISCONNECTED",
  GLASSES_DISCONNECTED = "GLASSES_DISCONNECTED",
  STALE_CONNECTION = "STALE_CONNECTION",
  WEBSOCKET_CLOSED = "WEBSOCKET_CLOSED",
  WIFI_NOT_CONNECTED = "WIFI_NOT_CONNECTED",
}

export class ConnectionValidator {
  private static readonly STALE_CONNECTION_THRESHOLD_MS = 60000; // 1 minute

  // SAFETY FLAG: Set to true to enable validation, false to bypass all checks
  private static readonly VALIDATION_ENABLED = true; // Enabled to enforce connection guards in production

  /**
   * Validate connections for hardware requests (photo, display, audio)
   * Checks both phone WebSocket and glasses connection state
   */
  static validateForHardwareRequest(
    userSession: UserSession,
    requestType: "photo" | "display" | "audio" | "sensor" | "stream",
  ): ValidationResult {
    // SAFETY BYPASS: Return success immediately if validation is disabled
    if (!ConnectionValidator.VALIDATION_ENABLED) {
      logger.debug(
        {
          userId: userSession.userId,
          requestType,
          bypassReason: "VALIDATION_ENABLED=false",
          feature: "device-state",
        },
        "Connection validation bypassed - returning success",
      );
      return { valid: true };
    }

    // Check phone WebSocket connection first
    // Note: These are validation failures, not system errors - users disconnecting is expected behavior
    if (!userSession.websocket) {
      logger.debug(
        {
          userId: userSession.userId,
          requestType,
          feature: "device-state",
        },
        "Hardware request skipped - no WebSocket connection",
      );

      return {
        valid: false,
        error: `Cannot process ${requestType} request - phone is not connected (no WebSocket)`,
        errorCode: ConnectionErrorCode.WEBSOCKET_CLOSED,
      };
    }

    if (userSession.websocket.readyState !== WebSocketReadyState.OPEN) {
      logger.debug(
        {
          userId: userSession.userId,
          requestType,
          readyState: userSession.websocket.readyState,
          feature: "device-state",
        },
        "Hardware request skipped - WebSocket not open",
      );

      return {
        valid: false,
        error: `Cannot process ${requestType} request - phone WebSocket is not open (state: ${userSession.websocket.readyState})`,
        errorCode: ConnectionErrorCode.WEBSOCKET_CLOSED,
      };
    }

    // Check glasses connection state via DeviceManager
    const isGlassesConnected = userSession.deviceManager.isGlassesConnected;
    const model = userSession.deviceManager.getModel();

    // HOTFIX: Simulated Glasses don't send connection state via WebSocket
    // Treat them as always connected if they're the selected model
    // Remove this once mobile client properly sends device state updates
    const isSimulatedGlasses = model === "Simulated Glasses";

    if (!isGlassesConnected && !isSimulatedGlasses) {
      logger.debug(
        {
          userId: userSession.userId,
          requestType,
          glassesModel: model,
          feature: "device-state",
        },
        "Hardware request skipped - glasses not connected",
      );

      return {
        valid: false,
        error: `Cannot process ${requestType} request - smart glasses are not connected`,
        errorCode: ConnectionErrorCode.GLASSES_DISCONNECTED,
      };
    }

    // Optional: Check if connection state is stale
    const deviceState = userSession.deviceManager.getDeviceState();
    if (deviceState.timestamp) {
      const ageMs = Date.now() - new Date(deviceState.timestamp).getTime();
      if (ageMs > ConnectionValidator.STALE_CONNECTION_THRESHOLD_MS) {
        logger.warn(
          {
            userId: userSession.userId,
            requestType,
            ageMs,
            lastUpdate: deviceState.timestamp,
            feature: "device-state",
          },
          "Glasses connection state may be stale",
        );

        // Note: We log a warning but don't fail the request
        // This could be changed to return an error if stricter validation is needed
      }
    }

    // All checks passed
    logger.debug(
      {
        userId: userSession.userId,
        requestType,
        glassesModel: userSession.deviceManager.getModel(),
        feature: "device-state",
      },
      "Hardware request validation successful",
    );

    return { valid: true };
  }

  /**
   * Check if only phone is connected (glasses not required)
   * Used for operations that only need phone connection
   */
  static validatePhoneConnection(userSession: UserSession): ValidationResult {
    // SAFETY BYPASS: Return success immediately if validation is disabled
    if (!ConnectionValidator.VALIDATION_ENABLED) {
      logger.debug(
        {
          userId: userSession.userId,
          bypassReason: "VALIDATION_ENABLED=false",
          feature: "device-state",
        },
        "Phone connection validation bypassed - returning success",
      );
      return { valid: true };
    }

    if (!userSession.websocket || userSession.websocket.readyState !== WebSocketReadyState.OPEN) {
      return {
        valid: false,
        error: "Phone is not connected",
        errorCode: ConnectionErrorCode.PHONE_DISCONNECTED,
      };
    }

    return { valid: true };
  }

  /**
   * Validate that glasses have WiFi connectivity for operations that require it
   * Uses device capabilities to determine if WiFi is required
   */
  static validateWifiForOperation(userSession: UserSession): ValidationResult {
    // SAFETY BYPASS: Return success immediately if validation is disabled
    if (!ConnectionValidator.VALIDATION_ENABLED) {
      logger.debug(
        {
          userId: userSession.userId,
          bypassReason: "VALIDATION_ENABLED=false",
          feature: "device-state",
        },
        "WiFi validation bypassed - returning success",
      );
      return { valid: true };
    }

    // Check if glasses have WiFi capability using DeviceManager
    const capabilities = userSession.deviceManager.getCapabilities();
    const requiresWifi = capabilities?.hasWifi === true;

    if (!requiresWifi) {
      // Glasses don't support WiFi, validation passes
      return { valid: true };
    }

    // Check if glasses are connected to WiFi
    const deviceState = userSession.deviceManager.getDeviceState();

    if (!deviceState.wifiConnected) {
      logger.debug(
        {
          userId: userSession.userId,
          glassesModel: userSession.deviceManager.getModel(),
          wifiConnected: deviceState.wifiConnected,
          feature: "device-state",
        },
        "WiFi validation failed - glasses not connected to WiFi",
      );

      return {
        valid: false,
        error: `Cannot process request - smart glasses must be connected to WiFi for this operation`,
        errorCode: ConnectionErrorCode.WIFI_NOT_CONNECTED,
      };
    }

    logger.debug(
      {
        userId: userSession.userId,
        glassesModel: userSession.deviceManager.getModel(),
        wifiSsid: deviceState.wifiSsid,
        feature: "device-state",
      },
      "WiFi validation successful",
    );

    return { valid: true };
  }

  /**
   * Get a human-readable connection status summary
   */
  static getConnectionStatus(userSession: UserSession): string {
    const parts: string[] = [];

    if (!userSession.websocket) {
      parts.push("No WebSocket");
    } else if (userSession.websocket.readyState !== WebSocketReadyState.OPEN) {
      parts.push(`WebSocket state: ${userSession.websocket.readyState}`);
    } else {
      parts.push("WebSocket: OPEN");
    }

    const isPhoneConnected = userSession.deviceManager.isPhoneConnected;
    parts.push(`Phone: ${isPhoneConnected ? "Connected" : "Disconnected"}`);
    parts.push(`Glasses: ${userSession.deviceManager.isGlassesConnected ? "Connected" : "Disconnected"}`);

    const model = userSession.deviceManager.getModel();
    if (model) {
      parts.push(`Model: ${model}`);
    }

    return parts.join(", ");
  }
}
