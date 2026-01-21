/**
 * @fileoverview AppSession class that consolidates all per-app state within a user session.
 *
 * This class is the single source of truth for an individual app's state, including:
 * - WebSocket connection
 * - Connection state (connecting, running, grace_period, stopped)
 * - Subscriptions
 * - Heartbeat management
 * - Grace period and resurrection handling
 * - Ownership release tracking
 *
 * Previously this state was scattered across AppManager, SubscriptionManager, and UserSession.
 * Consolidating it here makes the system easier to understand and maintain.
 */

import {Logger} from "pino"

import {ExtendedStreamType, StreamType, isLanguageStream, parseLanguageStream} from "@mentra/sdk"

import {ResourceTracker} from "../../utils/resource-tracker"
import {IWebSocket, WebSocketReadyState, hasEventEmitter} from "../websocket/types"

/**
 * Location rate/accuracy tier for location subscriptions
 */
export type LocationRate =
  | "standard"
  | "high"
  | "realtime"
  | "tenMeters"
  | "hundredMeters"
  | "kilometer"
  | "threeKilometers"
  | "reduced"

/**
 * Connection states for an app session
 */
export enum AppConnectionState {
  CONNECTING = "connecting", // Webhook sent, waiting for app to connect
  RUNNING = "running", // Active WebSocket connection
  GRACE_PERIOD = "grace_period", // Disconnected, waiting for SDK reconnection (5s)
  DORMANT = "dormant", // Grace expired, user not connected, waiting for user to return
  RESURRECTING = "resurrecting", // System actively restarting app
  STOPPING = "stopping", // User/system initiated stop in progress
  STOPPED = "stopped", // Fully stopped, can be restarted
}

/**
 * Configuration for creating an AppSession
 */
export interface AppSessionConfig {
  packageName: string
  logger: Logger
  onGracePeriodExpired: (appSession: AppSession) => Promise<void>
  onSubscriptionsChanged?: (
    appSession: AppSession,
    oldSubs: Set<ExtendedStreamType>,
    newSubs: Set<ExtendedStreamType>,
  ) => void
  onDisconnect?: (code: number, reason: string) => void
}

/**
 * Subscription history entry for debugging
 */
interface SubscriptionHistoryEntry {
  timestamp: Date
  subscriptions: ExtendedStreamType[]
  action: "add" | "remove" | "update"
}

/**
 * Ownership release info
 */
interface OwnershipReleaseInfo {
  reason: string
  timestamp: Date
}

// Heartbeat interval in milliseconds
const HEARTBEAT_INTERVAL_MS = 10000 // 10 seconds

// Grace period before resurrection attempt
const GRACE_PERIOD_MS = 5000 // 5 seconds

// Grace period for ignoring empty subscription updates after reconnect
const SUBSCRIPTION_GRACE_MS = 8000 // 8 seconds

// Enable detailed ping/pong logging
const LOG_PING_PONG = false

/**
 * AppSession - Consolidated per-app state within a user session
 *
 * This class manages all state for a single app connection, including:
 * - WebSocket lifecycle
 * - Connection state machine
 * - Subscriptions (single source of truth)
 * - Heartbeat/keepalive
 * - Grace period and resurrection
 * - Ownership release for clean handoffs
 */
export class AppSession {
  // ===== Identity =====
  public readonly packageName: string
  private readonly logger: Logger

  // ===== WebSocket Connection =====
  private _webSocket: IWebSocket | null = null
  private _state: AppConnectionState = AppConnectionState.STOPPED

  // ===== Timing =====
  private _connectedAt: Date | null = null
  private _disconnectedAt: Date | null = null
  private _startTime: Date | null = null // When app was first started (for session duration)
  private _lastReconnectAt: number = 0 // Timestamp for subscription grace handling

  // ===== Heartbeat =====
  private heartbeatInterval: NodeJS.Timeout | null = null
  private pongHandler: (() => void) | null = null

  // ===== Resource Tracking =====
  private resources = new ResourceTracker()
  private disposed = false

  // ===== Close Handler (for proper cleanup) =====
  private closeHandler: ((code: number, reason: Buffer) => void) | null = null
  private onDisconnectCallback: ((code: number, reason: string) => void) | null = null

  // ===== Grace Period =====
  private graceTimer: NodeJS.Timeout | null = null
  private readonly onGracePeriodExpired: (appSession: AppSession) => Promise<void>

  // ===== Ownership Release =====
  private _ownershipReleased: OwnershipReleaseInfo | null = null

  // ===== Subscriptions =====
  private _subscriptions: Set<ExtendedStreamType> = new Set()

  // ===== Update Queue (Issue 008) =====
  // Serializes async operations to prevent race conditions when multiple
  // subscription updates arrive rapidly during app startup.
  private updateQueue: Promise<void> = Promise.resolve()
  private subscriptionHistory: SubscriptionHistoryEntry[] = []
  private readonly onSubscriptionsChanged?: (
    appSession: AppSession,
    oldSubs: Set<ExtendedStreamType>,
    newSubs: Set<ExtendedStreamType>,
  ) => void

  // ===== Location Subscription Metadata =====
  // Location is the only subscription type with additional metadata (rate/accuracy tier)
  // This is stored separately rather than changing the subscription storage type
  private _locationRate: LocationRate | null = null

  // ===== Pending Connection (for startApp promise) =====
  private pendingConnection: {
    resolve: (success: boolean) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
    startTime: number
  } | null = null

  constructor(config: AppSessionConfig) {
    this.packageName = config.packageName
    this.logger = config.logger.child({
      service: "AppSession",
      packageName: config.packageName,
    })
    this.onGracePeriodExpired = config.onGracePeriodExpired
    this.onSubscriptionsChanged = config.onSubscriptionsChanged
    this.onDisconnectCallback = config.onDisconnect ?? null

    this.logger.debug("AppSession created")
  }

  // ===== Getters =====

  get webSocket(): IWebSocket | null {
    return this._webSocket
  }

  get state(): AppConnectionState {
    return this._state
  }

  get connectedAt(): Date | null {
    return this._connectedAt
  }

  get disconnectedAt(): Date | null {
    return this._disconnectedAt
  }

  get startTime(): Date | null {
    return this._startTime
  }

  get subscriptions(): Set<ExtendedStreamType> {
    return this._subscriptions
  }

  get locationRate(): LocationRate | null {
    return this._locationRate
  }

  get isRunning(): boolean {
    return this._state === AppConnectionState.RUNNING
  }

  get isConnecting(): boolean {
    return this._state === AppConnectionState.CONNECTING
  }

  get isInGracePeriod(): boolean {
    return this._state === AppConnectionState.GRACE_PERIOD
  }

  get isStopped(): boolean {
    return this._state === AppConnectionState.STOPPED
  }

  get isDormant(): boolean {
    return this._state === AppConnectionState.DORMANT
  }

  get ownershipReleased(): boolean {
    return this._ownershipReleased !== null
  }

  get ownershipReleaseInfo(): OwnershipReleaseInfo | null {
    return this._ownershipReleased
  }

  // ===== Update Queue API =====

  /**
   * Queue an async operation to be serialized with other updates for this app.
   * Ensures operations complete in the order they arrive.
   *
   * Used to prevent race conditions when multiple subscription updates
   * arrive rapidly (e.g., during app startup). See Issue 008.
   *
   * @param operation - Async function to execute
   * @returns Promise that resolves with the operation's result
   */
  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T
    let operationError: Error | null = null

    this.updateQueue = this.updateQueue.then(async () => {
      try {
        result = await operation()
      } catch (e) {
        operationError = e as Error
        this.logger.error({error: e, packageName: this.packageName}, "Queued operation failed")
      }
    })

    await this.updateQueue

    if (operationError) {
      throw operationError
    }
    return result
  }

  // ===== State Machine =====

  private setState(newState: AppConnectionState): void {
    const oldState = this._state
    this._state = newState
    this.logger.debug({oldState, newState}, `State transition: ${oldState} -> ${newState}`)
  }

  // ===== Connection Lifecycle =====

  /**
   * Mark app as connecting (webhook sent, waiting for WebSocket)
   */
  startConnecting(): void {
    this.setState(AppConnectionState.CONNECTING)
    if (!this._startTime) {
      this._startTime = new Date()
    }
  }

  /**
   * Handle successful WebSocket connection
   */
  handleConnect(ws: IWebSocket): void {
    // Log if this is a reconnection during grace period or dormant state
    if (this._state === AppConnectionState.GRACE_PERIOD) {
      this.logger.info({previousState: this._state}, "✅ SDK reconnected during grace period - resurrection avoided!")
    } else if (this._state === AppConnectionState.DORMANT) {
      this.logger.info({previousState: this._state}, "✅ SDK reconnected while DORMANT - late reconnection accepted!")
    } else {
      this.logger.info("App connected")
    }

    // Remove old close handler if exists (from previous connection)
    this.removeCloseHandler()

    // Cancel any pending grace period
    this.cancelGracePeriod()

    // Clear ownership release flag (fresh connection)
    this._ownershipReleased = null

    // Update connection state
    this._webSocket = ws
    this._connectedAt = new Date()
    this._disconnectedAt = null
    this._lastReconnectAt = Date.now()
    this.setState(AppConnectionState.RUNNING)

    // Set up close handler (owned by AppSession for proper cleanup)
    this.closeHandler = (code: number, reason: Buffer) => {
      const reasonStr = reason.toString()
      this.logger.debug({code, reason: reasonStr}, "WebSocket close event received")

      // First handle internal state
      this.handleDisconnect(code, reasonStr)

      // Then notify AppManager if callback provided
      if (this.onDisconnectCallback) {
        this.onDisconnectCallback(code, reasonStr)
      }
    }
    // Only set up event-based close handler for ws package (not Bun's ServerWebSocket)
    // Bun's close handling is done in websocketHandlers.close()
    if (hasEventEmitter(ws)) {
      ws.on("close", this.closeHandler)
    }

    // Start heartbeat
    this.setupHeartbeat(ws)

    // Resolve pending connection if exists
    if (this.pendingConnection) {
      clearTimeout(this.pendingConnection.timeout)
      this.pendingConnection.resolve(true)
      this.pendingConnection = null
    }
  }

  /**
   * Remove the close handler from the WebSocket
   * This prevents memory leaks and stale callbacks after disposal
   */
  private removeCloseHandler(): void {
    if (this._webSocket && this.closeHandler && hasEventEmitter(this._webSocket)) {
      this._webSocket.off("close", this.closeHandler)
      this.logger.debug("Removed WebSocket close handler")
    }
    this.closeHandler = null
  }

  /**
   * Handle WebSocket disconnection
   */
  handleDisconnect(code: number, reason: string): void {
    this.logger.info({code, reason}, "App disconnected")

    this._disconnectedAt = new Date()

    // Clear heartbeat
    this.clearHeartbeat()

    // Clear WebSocket reference
    this._webSocket = null

    // Check if we're already stopping
    if (this._state === AppConnectionState.STOPPING) {
      this.logger.debug("App was stopping, completing stop")
      this.setState(AppConnectionState.STOPPED)
      return
    }

    // Check if ownership was released (clean handoff to another cloud)
    // Mark as DORMANT instead of STOPPED so the app will be resurrected if user returns to this cloud.
    // This is critical for multi-cloud support:
    // - All clouds share the same database (user.runningApps)
    // - We should NOT modify the database on ownership release
    // - If user reconnects to this cloud, resurrectDormantApps() will restart the app
    // - If user stays on the new cloud, this DORMANT app gets cleaned up when UserSession disposes
    if (this._ownershipReleased) {
      this.logger.info(
        {reason: this._ownershipReleased.reason},
        "Ownership was released (handoff to another cloud) - marking DORMANT for potential resurrection if user returns",
      )
      this.setState(AppConnectionState.DORMANT)
      this.cleanup()
      return
    }

    // Start grace period for potential reconnection
    this.logger.info("Starting grace period for reconnection")
    this.setState(AppConnectionState.GRACE_PERIOD)
    this.startGracePeriod()
  }

  /**
   * Handle ownership release message from SDK
   */
  handleOwnershipRelease(reason: string): void {
    this._ownershipReleased = {
      reason,
      timestamp: new Date(),
    }
    this.logger.info({reason}, "Ownership released - will not resurrect on disconnect")
  }

  /**
   * Mark app as stopping (user/system initiated)
   */
  markStopping(): void {
    this.setState(AppConnectionState.STOPPING)
    this.cancelGracePeriod()
  }

  /**
   * Mark app as stopped
   */
  markStopped(): void {
    this.setState(AppConnectionState.STOPPED)
    this.clearHeartbeat()
    this.cancelGracePeriod()
    this._webSocket = null
  }

  /**
   * Mark app as resurrecting
   */
  markResurrecting(): void {
    this.setState(AppConnectionState.RESURRECTING)
  }

  /**
   * Mark app as dormant.
   *
   * Dormant means: "App should be running, mini app WS is dead, grace period expired,
   * but user isn't connected so we can't resurrect yet."
   *
   * The app will be resurrected when:
   * 1. The SDK reconnects (late reconnection after grace period) - goes back to RUNNING
   * 2. The user reconnects to this cloud - triggers resurrectDormantApps()
   *
   * This state exists to handle the multi-cloud problem: we don't want to resurrect
   * an app if the user switched to another cloud. By waiting for user reconnection,
   * we ensure we only manage apps for users actively using THIS cloud.
   */
  markDormant(): void {
    this.setState(AppConnectionState.DORMANT)
    this.cancelGracePeriod()
  }

  // ===== Heartbeat Management =====

  private setupHeartbeat(ws: IWebSocket): void {
    this.clearHeartbeat()

    this.heartbeatInterval = setInterval(() => {
      if (this.disposed) return // Guard against stale callback
      if (ws.readyState === WebSocketReadyState.OPEN) {
        ws.ping?.()
        if (LOG_PING_PONG) {
          this.logger.debug("Sent ping")
        }
      } else {
        this.logger.warn("WebSocket not open during heartbeat, clearing")
        this.clearHeartbeat()
      }
    }, HEARTBEAT_INTERVAL_MS)

    // Track interval for automatic cleanup
    this.resources.trackInterval(this.heartbeatInterval)

    // Setup pong handler (store reference for cleanup)
    this.pongHandler = () => {
      if (this.disposed) return // Guard against stale callback
      if (LOG_PING_PONG) {
        this.logger.debug("Received pong")
      }
    }

    // Only set up event-based pong handler for ws package (not Bun's ServerWebSocket)
    // Bun's pong handling is done in websocketHandlers.pong()
    if (hasEventEmitter(ws)) {
      ws.on("pong", this.pongHandler)

      // Track pong handler for cleanup
      const pongRef = this.pongHandler
      this.resources.track(() => {
        if (hasEventEmitter(ws)) {
          ws.off("pong", pongRef)
        }
      })
    }

    this.logger.debug("Heartbeat started")
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
      this.logger.debug("Heartbeat cleared")
    }
    this.pongHandler = null
  }

  // ===== Grace Period Management =====

  private startGracePeriod(): void {
    this.cancelGracePeriod()

    this.graceTimer = setTimeout(async () => {
      this.logger.info("Grace period expired")

      if (this._state === AppConnectionState.GRACE_PERIOD && !this._ownershipReleased) {
        // No reconnect, no ownership release - trigger resurrection
        this.setState(AppConnectionState.RESURRECTING)
        try {
          await this.onGracePeriodExpired(this)
        } catch (error) {
          this.logger.error(error, "Error in grace period expiration handler")
        }
      }
    }, GRACE_PERIOD_MS)

    this.logger.debug({gracePeriodMs: GRACE_PERIOD_MS}, "Grace period started")
  }

  private cancelGracePeriod(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
      this.logger.debug("Grace period cancelled")
    }
  }

  // ===== Subscription Management =====

  /**
   * Update subscriptions for this app
   * @param newSubscriptions - Array of stream types to subscribe to
   * @param locationRate - Optional location rate/accuracy tier (only relevant if subscribing to location_stream)
   * Returns true if update was applied, false if ignored (e.g., empty update during grace)
   */
  updateSubscriptions(
    newSubscriptions: ExtendedStreamType[],
    locationRate?: LocationRate | null,
  ): {
    applied: boolean
    reason?: string
  } {
    const now = Date.now()
    const timeSinceReconnect = now - this._lastReconnectAt

    // Check for empty subscription update during reconnect grace window
    if (newSubscriptions.length === 0 && timeSinceReconnect <= SUBSCRIPTION_GRACE_MS) {
      this.logger.warn(
        {timeSinceReconnect, graceMs: SUBSCRIPTION_GRACE_MS},
        "Ignoring empty subscription update within reconnect grace window",
      )
      return {
        applied: false,
        reason: "Empty subscription ignored during grace window",
      }
    }

    const oldSubs = this._subscriptions
    const newSubs = new Set(newSubscriptions)

    // Store in history
    this.addToHistory(newSubscriptions, "update")

    // Update subscriptions
    this._subscriptions = newSubs

    // Update location rate if provided or clear if no longer subscribed to location
    if (locationRate !== undefined) {
      this._locationRate = locationRate
    } else if (!newSubs.has(StreamType.LOCATION_STREAM)) {
      this._locationRate = null
    }

    this.logger.info(
      {
        oldCount: oldSubs.size,
        newCount: newSubs.size,
        subscriptions: newSubscriptions,
        locationRate: this._locationRate,
      },
      "Subscriptions updated",
    )

    // Notify callback
    if (this.onSubscriptionsChanged) {
      this.onSubscriptionsChanged(this, oldSubs, newSubs)
    }

    return {applied: true}
  }

  /**
   * Add a single subscription
   */
  addSubscription(stream: ExtendedStreamType): void {
    if (!this._subscriptions.has(stream)) {
      const oldSubs = new Set(this._subscriptions)
      this._subscriptions.add(stream)
      this.addToHistory([...this._subscriptions], "add")

      this.logger.debug({stream}, "Subscription added")

      if (this.onSubscriptionsChanged) {
        this.onSubscriptionsChanged(this, oldSubs, this._subscriptions)
      }
    }
  }

  /**
   * Remove a single subscription
   */
  removeSubscription(stream: ExtendedStreamType): void {
    if (this._subscriptions.has(stream)) {
      const oldSubs = new Set(this._subscriptions)
      this._subscriptions.delete(stream)
      this.addToHistory([...this._subscriptions], "remove")

      this.logger.debug({stream}, "Subscription removed")

      if (this.onSubscriptionsChanged) {
        this.onSubscriptionsChanged(this, oldSubs, this._subscriptions)
      }
    }
  }

  /**
   * Get all subscriptions as array
   */
  getSubscriptions(): ExtendedStreamType[] {
    return Array.from(this._subscriptions)
  }

  /**
   * Check if app has a specific subscription
   */
  hasSubscription(subscription: ExtendedStreamType): boolean {
    if (this._subscriptions.has(subscription)) return true
    if (this._subscriptions.has(StreamType.WILDCARD)) return true
    if (this._subscriptions.has(StreamType.ALL)) return true

    // For language streams, check if we have a matching base type + language
    if (isLanguageStream(subscription as string)) {
      const incomingParsed = parseLanguageStream(subscription as string)
      if (incomingParsed) {
        for (const sub of this._subscriptions) {
          if (isLanguageStream(sub as string)) {
            const subParsed = parseLanguageStream(sub as string)
            if (
              subParsed &&
              subParsed.type === incomingParsed.type &&
              subParsed.transcribeLanguage === incomingParsed.transcribeLanguage
            ) {
              return true
            }
          }
        }
      }
    }

    return false
  }

  /**
   * Clear all subscriptions
   */
  clearSubscriptions(): void {
    const oldSubs = this._subscriptions
    this._subscriptions = new Set()
    this._locationRate = null
    this.addToHistory([], "remove")

    this.logger.debug("All subscriptions cleared")

    if (this.onSubscriptionsChanged && oldSubs.size > 0) {
      this.onSubscriptionsChanged(this, oldSubs, this._subscriptions)
    }
  }

  /**
   * Set location rate/accuracy tier
   * Used when app subscribes to location_stream with a specific rate
   */
  setLocationRate(rate: LocationRate | null): void {
    this._locationRate = rate
    this.logger.debug({rate}, "Location rate updated")
  }

  /**
   * Get location rate/accuracy tier
   */
  getLocationRate(): LocationRate | null {
    return this._locationRate
  }

  private addToHistory(subscriptions: ExtendedStreamType[], action: "add" | "remove" | "update"): void {
    this.subscriptionHistory.push({
      timestamp: new Date(),
      subscriptions: [...subscriptions],
      action,
    })

    // Keep only last 50 entries
    if (this.subscriptionHistory.length > 50) {
      this.subscriptionHistory = this.subscriptionHistory.slice(-50)
    }
  }

  /**
   * Get subscription history for debugging
   */
  getSubscriptionHistory(): SubscriptionHistoryEntry[] {
    return [...this.subscriptionHistory]
  }

  // ===== Pending Connection (for startApp) =====

  /**
   * Set up pending connection promise for startApp
   */
  setPendingConnection(resolve: (success: boolean) => void, reject: (error: Error) => void, timeoutMs: number): void {
    // Clear existing pending connection
    if (this.pendingConnection) {
      clearTimeout(this.pendingConnection.timeout)
      this.pendingConnection.reject(new Error("New connection attempt started"))
    }

    const timeout = setTimeout(() => {
      if (this.pendingConnection) {
        this.pendingConnection.reject(new Error(`Connection timeout after ${timeoutMs}ms`))
        this.pendingConnection = null
      }
    }, timeoutMs)

    this.pendingConnection = {
      resolve,
      reject,
      timeout,
      startTime: Date.now(),
    }
  }

  /**
   * Check if there's a pending connection
   */
  hasPendingConnection(): boolean {
    return this.pendingConnection !== null
  }

  /**
   * Get pending connection start time
   */
  getPendingConnectionStartTime(): number | null {
    return this.pendingConnection?.startTime ?? null
  }

  /**
   * Resolve pending connection with failure
   */
  rejectPendingConnection(error: Error): void {
    if (this.pendingConnection) {
      clearTimeout(this.pendingConnection.timeout)
      this.pendingConnection.reject(error)
      this.pendingConnection = null
    }
  }

  // ===== WebSocket Operations =====

  /**
   * Send a message to the app
   */
  send(message: any): boolean {
    if (!this._webSocket || this._webSocket.readyState !== WebSocketReadyState.OPEN) {
      this.logger.warn({messageType: message?.type}, "Cannot send message - WebSocket not open")
      return false
    }

    try {
      this._webSocket.send(JSON.stringify(message))
      return true
    } catch (error) {
      this.logger.error(error, "Error sending message")
      return false
    }
  }

  /**
   * Close the WebSocket connection
   */
  closeConnection(code: number = 1000, reason: string = ""): void {
    if (this._webSocket) {
      try {
        this._webSocket.close(code, reason)
      } catch (error) {
        this.logger.error(error, "Error closing WebSocket")
      }
      this._webSocket = null
    }
  }

  // ===== Cleanup =====

  /**
   * Full cleanup - call when app is being removed
   */
  cleanup(): void {
    if (this.disposed) return // Idempotent
    this.disposed = true

    this.logger.debug("Cleaning up AppSession")

    // Clean up all tracked resources (removes event listeners, clears timers)
    this.resources.dispose()

    this.clearHeartbeat()
    this.cancelGracePeriod()

    // Remove close handler BEFORE closing connection to prevent it from firing
    this.removeCloseHandler()

    this.closeConnection(1000, "App session cleanup")

    if (this.pendingConnection) {
      clearTimeout(this.pendingConnection.timeout)
      this.pendingConnection.reject(new Error("App session cleanup"))
      this.pendingConnection = null
    }

    this._subscriptions.clear()
    this._ownershipReleased = null
    this._connectedAt = null
    this._disconnectedAt = null
    this.onDisconnectCallback = null
  }

  /**
   * Dispose - full cleanup and mark as stopped
   */
  dispose(): void {
    this.cleanup()
    this.setState(AppConnectionState.STOPPED)
    this.logger.info("AppSession disposed")
  }

  /**
   * Check if this AppSession has been disposed
   */
  get isDisposed(): boolean {
    return this.disposed
  }

  // ===== Debug/Inspection =====

  /**
   * Get a snapshot of the current state for debugging
   */
  getSnapshot(): {
    packageName: string
    state: AppConnectionState
    isConnected: boolean
    subscriptionCount: number
    subscriptions: ExtendedStreamType[]
    connectedAt: Date | null
    disconnectedAt: Date | null
    startTime: Date | null
    ownershipReleased: boolean
    ownershipReleaseReason: string | null
  } {
    return {
      packageName: this.packageName,
      state: this._state,
      isConnected: this._webSocket !== null && this._webSocket.readyState === WebSocketReadyState.OPEN,
      subscriptionCount: this._subscriptions.size,
      subscriptions: this.getSubscriptions(),
      connectedAt: this._connectedAt,
      disconnectedAt: this._disconnectedAt,
      startTime: this._startTime,
      ownershipReleased: this._ownershipReleased !== null,
      ownershipReleaseReason: this._ownershipReleased?.reason ?? null,
    }
  }
}

export default AppSession
