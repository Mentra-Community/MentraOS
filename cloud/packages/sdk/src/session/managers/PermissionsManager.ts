/**
 * PermissionsManager — App Permission State
 *
 * Tracks which permissions the current app has been granted based on
 * the app's manifest/registration on the developer console. Permissions
 * are populated when the session connects (from CONNECTION_ACK settings)
 * and can be queried synchronously by other managers.
 *
 * This manager is read-only from the app's perspective — permissions are
 * controlled by the platform, not the app.
 *
 * @example
 * ```ts
 * // Check a single permission
 * if (permissions.has("camera")) {
 *   // Safe to use camera APIs
 * }
 *
 * // Get all permissions
 * const all = permissions.getAll();
 * console.log("Notifications allowed:", all.notifications);
 *
 * // React to permission changes
 * const cleanup = permissions.onUpdate((perms) => {
 *   console.log("Permissions updated:", perms);
 * });
 * ```
 *
 * @module
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Permission types supported by the MentraOS platform.
 *
 * These correspond to capabilities and data streams that require
 * explicit opt-in via the developer console app manifest.
 */
export type PermissionType = "location" | "microphone" | "camera" | "notifications" | "calendar";

/**
 * Complete permission record mapping every permission type to its grant status.
 */
export type PermissionRecord = Record<PermissionType, boolean>;

/**
 * Dependencies injected by MentraSession.
 */
export interface PermissionsManagerDeps {
  /** Logger instance scoped to the session. */
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** All known permission types, used for iteration and defaults. */
const ALL_PERMISSIONS: readonly PermissionType[] = [
  "location",
  "microphone",
  "camera",
  "notifications",
  "calendar",
] as const;

/**
 * Returns a fresh default permission record with all permissions denied.
 */
function createDefaultPermissions(): PermissionRecord {
  return {
    location: false,
    microphone: false,
    camera: false,
    notifications: false,
    calendar: false,
  };
}

// ─── PermissionsManager ─────────────────────────────────────────────────────

/**
 * Manages the permission state for the current app session.
 *
 * Permissions are populated from the CONNECTION_ACK payload when the
 * session is established. Other managers (DeviceManager, PhoneManager)
 * query this manager to gate access to protected streams.
 *
 * The manager emits updates whenever the permission set changes, allowing
 * UI or logic to react to permission grants/revocations in real time.
 */
export class PermissionsManager {
  /** Current permission state. */
  private permissions: PermissionRecord;

  /** Registered update listeners. */
  private listeners: Set<(permissions: PermissionRecord) => void> = new Set();

  /** Logger instance. */
  private logger: PermissionsManagerDeps["logger"];

  /** Message handler registry for cloud message subscriptions. */
  private messageHandlers: PermissionsManagerDeps["messageHandlers"];

  constructor(deps: PermissionsManagerDeps) {
    this.logger = deps.logger;
    this.messageHandlers = deps.messageHandlers;
    this.permissions = createDefaultPermissions();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Check whether the app has been granted a specific permission.
   *
   * @param permission - The permission type to check
   * @returns `true` if the permission is granted, `false` otherwise
   *
   * @example
   * ```ts
   * if (permissions.has("microphone")) {
   *   session.events.onTranscription(handler);
   * }
   * ```
   */
  has(permission: PermissionType): boolean {
    return this.permissions[permission] ?? false;
  }

  /**
   * Get a snapshot of all permissions as a record.
   *
   * The returned object is a copy — mutations do not affect internal state.
   *
   * @returns A record mapping every {@link PermissionType} to its grant status
   *
   * @example
   * ```ts
   * const perms = permissions.getAll();
   * console.log("Camera:", perms.camera);
   * console.log("Location:", perms.location);
   * ```
   */
  getAll(): PermissionRecord {
    return { ...this.permissions };
  }

  /**
   * Subscribe to permission updates.
   *
   * The handler is called whenever the permission set changes (e.g., on
   * CONNECTION_ACK or a mid-session settings update). It receives a
   * snapshot copy of the full permission record.
   *
   * @param handler - Callback invoked with the updated permission record
   * @returns Cleanup function that removes the listener
   *
   * @example
   * ```ts
   * const cleanup = permissions.onUpdate((perms) => {
   *   if (!perms.camera) {
   *     console.warn("Camera permission revoked");
   *   }
   * });
   *
   * // Later: stop listening
   * cleanup();
   * ```
   */
  onUpdate(handler: (permissions: PermissionRecord) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /**
   * Listen for permission error events from the cloud.
   * Fires when a bulk subscription is rejected due to missing permissions.
   *
   * @param handler - Callback invoked with the error details
   * @returns Cleanup function that removes the listener
   *
   * @example
   * ```ts
   * const cleanup = permissions.onPermissionError((err) => {
   *   console.error("Permission error:", err.message, err.deniedPermissions);
   * });
   * ```
   */
  onPermissionError(handler: (error: { message: string; deniedPermissions?: string[] }) => void): () => void {
    const cleanup = this.messageHandlers.register("permission_error", (msg: any) => {
      try {
        handler({ message: msg.message ?? "Permission error", deniedPermissions: msg.deniedPermissions });
      } catch (err) {
        this.logger.error("[PermissionsManager] Error in onPermissionError handler:", err);
      }
    });
    return cleanup;
  }

  /**
   * Listen for permission denied events from the cloud.
   * Fires when an individual stream subscription is rejected.
   *
   * @param handler - Callback invoked with the denial details
   * @returns Cleanup function that removes the listener
   *
   * @example
   * ```ts
   * const cleanup = permissions.onPermissionDenied((err) => {
   *   console.warn("Denied:", err.permission, err.streamType);
   * });
   * ```
   */
  onPermissionDenied(handler: (error: { message: string; permission?: string; streamType?: string }) => void): () => void {
    const cleanup = this.messageHandlers.register("permission_denied", (msg: any) => {
      try {
        handler({ message: msg.message ?? "Permission denied", permission: msg.permission, streamType: msg.streamType });
      } catch (err) {
        this.logger.error("[PermissionsManager] Error in onPermissionDenied handler:", err);
      }
    });
    return cleanup;
  }

  // ─── Internal (called by MentraSession) ─────────────────────────────────

  /**
   * Update permissions from connection settings or a settings update payload.
   *
   * Called internally by MentraSession when:
   * - A CONNECTION_ACK is received with initial settings/permissions
   * - A mid-session settings update includes permission changes
   *
   * Accepts flexible input — extracts permissions from nested structures
   * commonly found in CONNECTION_ACK and settings_update payloads.
   *
   * @param settings - The raw settings object from the cloud message
   * @internal
   */
  updateFromSettings(settings: any): void {
    if (!settings) {
      this.logger.debug("PermissionsManager: No settings provided, skipping update");
      return;
    }

    const previous = { ...this.permissions };
    let updated = false;

    // Extract permissions from various possible payload shapes:
    //   { permissions: { camera: true, ... } }
    //   { appPermissions: { camera: true, ... } }
    //   { camera: true, microphone: false, ... }  (flat)
    const permissionsSource = settings.permissions ?? settings.appPermissions ?? settings;

    for (const perm of ALL_PERMISSIONS) {
      if (perm in permissionsSource) {
        const value = Boolean(permissionsSource[perm]);
        if (this.permissions[perm] !== value) {
          this.permissions[perm] = value;
          updated = true;
        }
      }
    }

    if (updated) {
      this.logger.info(
        "PermissionsManager: Permissions updated — " +
          ALL_PERMISSIONS.map((p) => `${p}=${this.permissions[p]}`).join(", "),
      );

      // Log individual changes at debug level
      for (const perm of ALL_PERMISSIONS) {
        if (previous[perm] !== this.permissions[perm]) {
          this.logger.debug(`PermissionsManager: ${perm}: ${previous[perm]} → ${this.permissions[perm]}`);
        }
      }

      // Notify listeners with a snapshot copy
      const snapshot = this.getAll();
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch (err) {
          this.logger.error(
            `PermissionsManager: Error in onUpdate listener: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else {
      this.logger.debug("PermissionsManager: No permission changes detected");
    }
  }
}
