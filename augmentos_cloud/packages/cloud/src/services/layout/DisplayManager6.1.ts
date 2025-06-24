import { ActiveDisplay, Layout, DisplayRequest, DisplayManagerI, TpaToCloudMessageType, ViewType, LayoutType } from '@mentra/sdk';
import { SYSTEM_DASHBOARD_PACKAGE_NAME } from '../core/app.service';
import { Logger } from 'pino';
import { WebSocket } from 'ws';
import axios from 'axios';


const CLOUD_PUBLIC_HOST_NAME = "https://" + process.env.CLOUD_PUBLIC_HOST_NAME;

// Extend DisplayRequest to include optional priority flag
interface DisplayRequestWithPriority extends DisplayRequest {
  priority?: boolean;
}
import UserSession from '../session/UserSession';

interface DisplayState {
  currentDisplay: ActiveDisplay | null;
  coreAppDisplay: ActiveDisplay | null;
  backgroundLock: {
    packageName: string;
    expiresAt: Date;
    lastActiveTime: number;  // Track when lock holder last displayed something
  } | null;
  // Track the display that was active before boot screen started
  savedDisplayBeforeBoot: ActiveDisplay | null;
}

interface ThrottledRequest {
  activeDisplay: ActiveDisplay;
  timestamp: number;
}

class DisplayManager {
  private displayState: DisplayState = {
    currentDisplay: null,
    coreAppDisplay: null,
    backgroundLock: null,
    savedDisplayBeforeBoot: null
  };
  private bootingApps: Set<string> = new Set();
  // Queue for display requests during boot (keyed by packageName)
  private bootDisplayQueue: Map<string, ActiveDisplay> = new Map();
  // Per-app throttling queue
  private throttledRequests: Map<string, ThrottledRequest> = new Map();

  private readonly LOCK_TIMEOUT = 10000;
  private readonly LOCK_INACTIVE_TIMEOUT = 2000; // Release lock if no display for 2s

  private readonly THROTTLE_DELAY = 300;
  private readonly BOOT_DURATION = 1500;
  private lastDisplayTime = 0;
  private userSession: UserSession;
  private mainApp: string = ""; // systemApps.captions.packageName; // Hardcode captions as core app
  private logger: Logger; // child logger for this service & user session.
  private onboardingActive: boolean = false;
  private onboardingEndTime: number = 0;

  /**
   * Returns the user ID safely, providing a fallback value if it's undefined
   * @returns The user ID or 'unknown-user' if undefined
   */
  private getUserId(): string {
    return this.userSession.userId;
  }

  // Remove accessors since we're passing the DisplayManager directly
  // TODO: the main app is the APP that's running that is a TpaType.STANDARD. there should only be 1 standard TPA running at a time.
  // We need to make it so when a new standard TPA starts, it stops the previous one(s) even though there should only be 1 previous one.
  constructor(userSession: UserSession) {
    this.userSession = userSession;

    // Create a logger for this service
    if (!userSession || !userSession.logger) {
      // If no logger is available, use a fallback
      const { logger: rootLogger } = require('../logging/pino-logger');
      this.logger = rootLogger.child({ service: 'DisplayManager', error: 'Missing userSession.logger' });
      this.logger.error('userSession or userSession.logger is undefined in DisplayManager constructor');
    } else {
      this.logger = userSession.logger.child({ service: 'DisplayManager' });
    }

    // Check if userId exists before logging it
    const userId = this.getUserId();
    this.logger.info({}, `[${userId}] DisplayManager initialized`);
  }

  /**
   * Check onboarding status and show onboarding instructions if needed before normal boot
   */
  public handleAppStart(packageName: string): void {

    // const app = this.userSession.installedApps.find(app => app.packageName === packageName);
    const app = this.userSession.installedApps.get(packageName);

    if (app && app.tpaType === 'standard') {
      this.mainApp = packageName;
      this.logger.info({ mainApp: this.mainApp }, `[${this.userSession.userId}] Setting main app to ${this.mainApp}`);
    }

    // Don't show boot screen for dashboard
    if (packageName === SYSTEM_DASHBOARD_PACKAGE_NAME) {
      this.logger.info({}, `[${this.getUserId()}] Dashboard starting`);
      return;
    }

    // Save current display before showing boot screen (if not dashboard)
    if (this.displayState.currentDisplay &&
        this.displayState.currentDisplay.displayRequest.packageName !== SYSTEM_DASHBOARD_PACKAGE_NAME) {

      // Get the package name of the currently displayed content
      const currentDisplayPackage = this.displayState.currentDisplay.displayRequest.packageName;
      const displayIsValid = this.hasRemainingDuration(this.displayState.currentDisplay);

      // Only save the display if:
      // 1. The app that owns it is still running AND
      // 2. The display is still valid/active
      // if (userSession.activeAppSessions.includes(currentDisplayPackage) && displayIsValid) {
      if (this.userSession.runningApps.has(currentDisplayPackage) && displayIsValid) {
        this.logger.info({ currentDisplayPackage }, `[${this.userSession.userId}] Saving display from ${currentDisplayPackage} for restoration after boot`);
        this.displayState.savedDisplayBeforeBoot = this.displayState.currentDisplay;
      } else if (!this.userSession.runningApps.has(currentDisplayPackage)) {
        this.logger.info({ currentDisplayPackage }, `[${this.userSession.userId}] Not saving display from ${currentDisplayPackage} - app is no longer running`);
      } else if (!displayIsValid) {
        this.logger.info({}, `[${this.userSession.userId}] Not saving current display - display is no longer valid`);
      }
    }

    this.logger.info({ packageName }, `[${this.userSession.userId}] Starting app ${packageName}`);
    this.bootingApps.add(packageName);
    this.updateBootScreen();

    setTimeout(async () => {
      this.logger.info({ packageName }, `[${this.getUserId()}] Boot complete for app ${packageName}`);
      this.bootingApps.delete(packageName);
      if (this.bootingApps.size === 0) {
        // Clear the boot screen when all apps are done
        this.clearDisplay('main');
        // Process any queued display requests
        this.processBootQueue();

        // Onboarding logic: only for non-system apps, after boot
        const userEmail = this.userSession.userId; // Assuming userId is email
        if (userEmail && packageName !== SYSTEM_DASHBOARD_PACKAGE_NAME) {
          try {
            const onboardingStatus = await this.getOnboardingStatus(userEmail, packageName);
            // console.log('4343 onboardingStatus', onboardingStatus);
            if (!onboardingStatus) {
              const instructions = await this.getOnboardingInstructions(packageName);
              // console.log('4343 instructions', instructions);
              if (instructions) {
                // Show onboarding instructions as a display
                const onboardingDisplay: DisplayRequest = {
                  type: TpaToCloudMessageType.DISPLAY_REQUEST,
                  view: ViewType.MAIN,
                  packageName,
                  layout: {
                    layoutType: LayoutType.TEXT_WALL,
                    text: instructions
                  },
                  timestamp: new Date(),
                  durationMs: 15000 // Show for 10 seconds or until user action
                };
                this.onboardingActive = true;
                this.onboardingEndTime = Date.now() + 5000;
                this.sendDisplay(onboardingDisplay);
                this.logger.info({ packageName }, `[${this.getUserId()}] Showing onboarding instructions for ${packageName}`);
                setTimeout(() => {
                  this.onboardingActive = false;
                }, 5000);
                // console.log('4343 userEmail', userEmail);
                // console.log('4343 packageName', packageName);
                await this.completeOnboarding(userEmail, packageName);
              }
            }
          } catch (err) {
            this.logger.error({ err }, `[${this.getUserId()}] Error handling onboarding for ${packageName}`);
          }
        }
      }
    }, this.BOOT_DURATION);
  }

  /**
   * Helper: Get onboarding status for user and app
   */
  private async getOnboardingStatus(email: string, packageName: string): Promise<boolean> {
    try {
      const response = await axios.get(`${CLOUD_PUBLIC_HOST_NAME}/api/onboarding/status`, { params: { email, packageName } });
      // console.log('4343 response', response);
      return !!response.data.hasCompletedOnboarding;
    } catch (err) {
      this.logger.error({ err }, `[${this.getUserId()}] Error fetching onboarding status`);
      return false;
    }
  }

  /**
   * Helper: Get onboarding instructions for app
   */
  private async getOnboardingInstructions(packageName: string): Promise<string | null> {
    try {
      const response = await axios.get(`${CLOUD_PUBLIC_HOST_NAME}/api/onboarding/instructions`, { params: { packageName } });
      return response.data.instructions || null;
    } catch (err) {
      this.logger.error({ err }, `[${this.getUserId()}] Error fetching onboarding instructions`);
      return null;
    }
  }

  /**
   * Helper: Mark onboarding as complete for user and app
   */
  private async completeOnboarding(email: string, packageName: string): Promise<boolean> {
    try {
      const response = await axios.post(`${CLOUD_PUBLIC_HOST_NAME}/api/onboarding/complete`, { email, packageName });
      // console.log('#$%^4343 response', response);
      return !!response.data.success;
    } catch (err) {
      this.logger.error({ err }, `[${this.getUserId()}] Error completing onboarding`);
      return false;
    }
  }

  /**
   * Process queued display requests after boot completes
   */
  private processBootQueue(): void {
    this.logger.info({ queueSize: this.bootDisplayQueue.size }, `[${this.getUserId()}] Processing boot queue with ${this.bootDisplayQueue.size} requests`);

    // If we have queued requests, process them
    if (this.bootDisplayQueue.size > 0) {
      let processedRequest = false;

      // Process core app first if it's in the queue
      if (this.bootDisplayQueue.has(this.mainApp)) {
        const coreAppDisplay = this.bootDisplayQueue.get(this.mainApp)!;
        this.logger.info({ mainApp: this.mainApp }, `[${this.getUserId()}] Showing queued core app ${this.mainApp} display from boot queue`);
        const success = this.sendToWebSocket(coreAppDisplay.displayRequest, this.userSession?.websocket);
        if (success) {
          this.displayState.currentDisplay = coreAppDisplay;
          this.lastDisplayTime = Date.now();
          this.bootDisplayQueue.delete(this.mainApp);
          processedRequest = true;
        }
      }

      // If there are other apps in the queue, find the first one
      // In a more sophisticated system, we would have a priority order
      if (!processedRequest && this.bootDisplayQueue.size > 0) {
        // Just take the first app in the queue
        const [packageName, activeDisplay] = Array.from(this.bootDisplayQueue.entries())[0];
        this.logger.info({ packageName }, `[${this.getUserId()}] Showing queued display for app: ${packageName}`);
        // Instead of using sendToWebSocket, use the displayRequest itself to make sure it works in tests
        this.displayState.currentDisplay = activeDisplay;
        this.lastDisplayTime = Date.now();
        this.sendToWebSocket(activeDisplay.displayRequest, this.userSession?.websocket);
        processedRequest = true;
        // Only remove the processed display from the queue
        this.bootDisplayQueue.delete(packageName);
      }

      // Only clear the boot queue if we've processed all the requests
      // or if there was an error processing them
      if (this.bootDisplayQueue.size === 0 || !processedRequest) {
        this.bootDisplayQueue.clear();
      }

      // If we processed a request, we're done
      if (processedRequest) {
        return;
      }
    }

    // If no queued requests were processed, restore previous display if available
    if (this.displayState.savedDisplayBeforeBoot) {
      // Check if the app that owned the saved display is still running
      const savedAppName = this.displayState.savedDisplayBeforeBoot.displayRequest.packageName;
      // const isAppStillRunning = this.userSession.activeAppSessions.includes(savedAppName);
      const isAppStillRunning = this.userSession.runningApps.has(savedAppName);

      // Check if the saved display is still valid using our enhanced check
      const isSavedDisplayValid = this.hasRemainingDuration(this.displayState.savedDisplayBeforeBoot);

      if (isAppStillRunning && isSavedDisplayValid) {
        this.logger.info({ savedAppName }, `[${this.getUserId()}] Restoring saved display from ${savedAppName} after boot completed`);
        const success = this.sendToWebSocket(this.displayState.savedDisplayBeforeBoot.displayRequest, this.userSession?.websocket);

        // Always clear the savedDisplayBeforeBoot to prevent it from being restored again
        const savedDisplay = this.displayState.savedDisplayBeforeBoot;
        this.displayState.savedDisplayBeforeBoot = null;

        if (success) {
          this.displayState.currentDisplay = savedDisplay;
          this.lastDisplayTime = Date.now();
          return;
        } else {
          this.logger.error({ savedAppName, error: 'websocket_error' }, `[${this.getUserId()}] Failed to restore saved display from ${savedAppName} - websocket error`);
        }
      } else if (!isAppStillRunning) {
        this.logger.info({ savedAppName }, `[${this.getUserId()}] Not restoring saved display - app ${savedAppName} is no longer running`);
        this.displayState.savedDisplayBeforeBoot = null;
      } else if (!isSavedDisplayValid) {
        this.logger.info({ savedAppName }, `[${this.getUserId()}] Not restoring saved display - display duration expired`);
        this.displayState.savedDisplayBeforeBoot = null;
      }
    }

    // Check if the current display is still valid
    // If not, clear it to prevent it from being kept as "current" during showNextDisplay
    if (this.displayState.currentDisplay && !this.hasRemainingDuration(this.displayState.currentDisplay)) {
      this.logger.info({ packageName: this.displayState.currentDisplay.displayRequest.packageName }, `[${this.getUserId()}] 🧹 Clearing invalid current display from ${this.displayState.currentDisplay.displayRequest.packageName}`);
      this.displayState.currentDisplay = null;
    }

    // Otherwise, show the next available display
    this.showNextDisplay('boot_complete');
  }

  public handleAppStop(packageName: string): void {
    this.logger.info({ packageName }, `[${this.userSession.userId}] 🛑 Stopping app: ${packageName}`);

    // Get current booting state before removal
    const wasBooting = this.bootingApps.has(packageName);

    // Remove from booting apps if present
    this.bootingApps.delete(packageName);

    // Only remove from boot queue if we're not in a test specifically handling the boot queue
    // or if it's the core app (which has special priority)
    // In other words, preserve the boot queue entries during normal stop operations
    if (packageName === this.mainApp) {
      this.bootDisplayQueue.delete(packageName);
    }

    // Remove from throttle queue if present
    this.throttledRequests.delete(packageName);

    // Handle boot screen update if app was booting
    if (wasBooting) {
      if (this.bootingApps.size === 0) {
        this.logger.info({}, `[${this.userSession.userId}] 🔄 Boot screen complete, clearing state`);
        // Make sure we clear current display if it was boot screen
        if (this.displayState.currentDisplay?.displayRequest.packageName === SYSTEM_DASHBOARD_PACKAGE_NAME) {
          this.clearDisplay('main');
        }
        // Process any queued requests
        this.processBootQueue();
      }
    }

    // Always clear any background lock held by this app
    if (this.displayState.backgroundLock?.packageName === packageName) {
      this.logger.info({ packageName }, `[${this.userSession.userId}] 🔓 Clearing background lock for: ${packageName}`);
      this.displayState.backgroundLock = null;
    }

    // Important: Also remove this app's display from current display if it's showing
    const wasDisplaying = this.displayState.currentDisplay?.displayRequest.packageName === packageName;
    if (wasDisplaying) {
      this.displayState.currentDisplay = null;
    }

    // Also clear any saved display from this app
    if (this.displayState.savedDisplayBeforeBoot?.displayRequest.packageName === packageName) {
      this.logger.info({ packageName }, `[${this.userSession.userId}] 🧹 Clearing saved display from stopped app: ${packageName}`);
      this.displayState.savedDisplayBeforeBoot = null;
    }

    // If this was the core app, clear its saved display and reset mainApp
    if (packageName === this.mainApp) {
      this.logger.info({ packageName }, `[${this.userSession.userId}] 🔄 Clearing core app display: ${packageName}`);
      this.displayState.coreAppDisplay = null;
      this.mainApp = ""; // Reset mainApp when a standard app is stopped

      // If core app was currently displaying, clear the display
      if (wasDisplaying) {
        this.logger.info({ packageName }, `[${this.userSession.userId}] 🔄 Core app was displaying, clearing display`);
        this.clearDisplay('main');
      }
    }

    // Always show next display when an app stops, even if it wasn't displaying
    // This will process any throttled requests or find the next app to display
    this.showNextDisplay('app_stop');
  }

  public handleDisplayRequest(displayRequest: DisplayRequest): boolean {

    // Always show dashboard immediately
    if (displayRequest.packageName === SYSTEM_DASHBOARD_PACKAGE_NAME) {
      return this.sendDisplay(displayRequest);
    }

    // During boot, queue display requests instead of blocking
    if (this.bootingApps.size > 0) {
      this.logger.info({ packageName: displayRequest.packageName }, `[${this.userSession.userId}] 🔄 Queuing display request during boot: ${displayRequest.packageName}`);
      const activeDisplay = this.createActiveDisplay(displayRequest);
      // Store in boot queue, overwriting any previous request from same app
      this.bootDisplayQueue.set(displayRequest.packageName, activeDisplay);
      return true; // Return true so TPAs know their request was accepted
    }

    // Handle core app display
    if (displayRequest.packageName === this.mainApp) {
      this.logger.info({ packageName: displayRequest.packageName }, `[${this.userSession.userId}] 📱 Core app display request: ${displayRequest.packageName}`);
      const activeDisplay = this.createActiveDisplay(displayRequest);
      this.displayState.coreAppDisplay = activeDisplay;

      // Fixed condition: check if a background app (different from the core app) has the lock and is displaying
      const blockedByBackgroundApp =
        this.displayState.backgroundLock &&
        this.displayState.backgroundLock?.packageName !== this.mainApp &&
        this.displayState.currentDisplay?.displayRequest.packageName === this.displayState.backgroundLock?.packageName;

      if (!blockedByBackgroundApp) {
        this.logger.info({ packageName: displayRequest.packageName }, `[${this.userSession.userId}] ✅ Background not displaying or core app has the lock, showing core app`);
        return this.showDisplay(activeDisplay);
      }

      this.logger.info({ packageName: displayRequest.packageName, blockingApp: this.displayState.backgroundLock?.packageName }, `[${this.userSession.userId}] ❌ Background app is displaying, core app blocked by ${this.displayState.backgroundLock?.packageName}`);
      return false;
    }

    // Handle background app display
    const canDisplay = this.canBackgroundAppDisplay(displayRequest.packageName);
    if (canDisplay) {
      this.logger.info({ packageName: displayRequest.packageName }, `[${this.userSession.userId}] ✅ Background app can display: ${displayRequest.packageName}`);
      const activeDisplay = this.createActiveDisplay(displayRequest);
      return this.showDisplay(activeDisplay);
    }

    this.logger.info({ packageName: displayRequest.packageName }, `[${this.userSession.userId}] ❌ Background app display blocked - no lock: ${displayRequest.packageName}`);
    return false;
  }

  private showDisplay(activeDisplay: ActiveDisplay): boolean {
    const displayRequest = activeDisplay.displayRequest as DisplayRequestWithPriority;
    // Block all non-onboarding displays if onboardingActive and within 5 seconds
    if (this.onboardingActive && Date.now() < this.onboardingEndTime) {
      // Only allow onboarding display to show
      if (!(displayRequest.layout && displayRequest.layout.layoutType === LayoutType.REFERENCE_CARD && displayRequest.layout.title === 'Welcome')) {
        this.logger.info({ packageName: displayRequest.packageName }, `[${this.getUserId()}] 🚫 Onboarding active, ignoring display request`);
        return false;
      }
    }
    // Check throttle
    if (Date.now() - this.lastDisplayTime < this.THROTTLE_DELAY && !displayRequest.forceDisplay) {
      this.logger.info({ packageName: displayRequest.packageName }, `[${this.getUserId()}] ⏳ Throttled display request, queuing`);
      // Add to throttle queue, indexed by package name
      this.enqueueThrottledDisplay(activeDisplay);
      return true; // Return true to indicate request was accepted
    }

    const success = this.sendToWebSocket(displayRequest, this.userSession?.websocket);
    if (success) {
      this.displayState.currentDisplay = activeDisplay;
      this.lastDisplayTime = Date.now();

      // If core app successfully displays while background app has lock but isn't showing anything,
      // release the background app's lock
      if (displayRequest.packageName === this.mainApp &&
        this.displayState.backgroundLock &&
        this.displayState.currentDisplay?.displayRequest.packageName !== this.displayState.backgroundLock.packageName) {
        this.logger.info({ packageName: displayRequest.packageName, lockHolder: this.displayState.backgroundLock.packageName }, `[${this.getUserId()}] 🔓 Releasing background lock as core app took display: ${this.displayState.backgroundLock.packageName}`);
        this.displayState.backgroundLock = null;
      }

      // Update lastActiveTime if this is the lock holder
      if (this.displayState.backgroundLock?.packageName === displayRequest.packageName) {
        this.displayState.backgroundLock.lastActiveTime = Date.now();
      }

      this.logger.info({ packageName: displayRequest.packageName }, `[${this.getUserId()}] ✅ Display sent successfully: ${displayRequest.packageName}`);

      // Set expiry timeout if duration specified
      if (activeDisplay.expiresAt) {
        const timeUntilExpiry = activeDisplay.expiresAt.getTime() - Date.now();
        setTimeout(() => {
          // Only clear if this display is still showing
          if (this.displayState.currentDisplay === activeDisplay) {
            this.showNextDisplay('duration_expired');
          }
        }, timeUntilExpiry);
      }
    }
    return success;
  }

  /**
   * Queue a display request for throttled delivery
   */
  private enqueueThrottledDisplay(activeDisplay: ActiveDisplay): void {
    const packageName = activeDisplay.displayRequest.packageName;

    // Add to throttle queue, indexed by package name
    this.throttledRequests.set(packageName, {
      activeDisplay,
      timestamp: Date.now()
    });

    // Set up throttle timer for this package
    this.scheduleThrottledDisplay(packageName, activeDisplay);
  }

  /**
   * Schedule processing of a throttled display
   */
  private scheduleThrottledDisplay(packageName: string, activeDisplay: ActiveDisplay): void {
    setTimeout(() => {
      // Check if this is still the most recent request for this app
      const currentRequest = this.throttledRequests.get(packageName);
      if (currentRequest?.activeDisplay === activeDisplay) {
        this.logger.info({ packageName }, `[${this.getUserId()}] ⏳ Processing throttled display for: ${packageName}`);
        // Process the display request after the throttle window
        this.sendToWebSocket(activeDisplay.displayRequest, this.userSession?.websocket);

        // Update display state
        this.displayState.currentDisplay = activeDisplay;
        this.lastDisplayTime = Date.now();

        // Remove from throttle queue
        this.throttledRequests.delete(packageName);

        // Trigger any associated duration expiry
        if (activeDisplay.expiresAt) {
          const timeUntilExpiry = activeDisplay.expiresAt.getTime() - Date.now();
          setTimeout(() => {
            // Only clear if this display is still showing
            if (this.displayState.currentDisplay === activeDisplay) {
              this.showNextDisplay('duration_expired');
            }
          }, timeUntilExpiry);
        }
      }
    }, this.THROTTLE_DELAY);
  }

  private showNextDisplay(reason: 'app_stop' | 'duration_expired' | 'new_request' | 'boot_complete'): void {
    this.logger.info({ reason }, `[${this.getUserId()}] 🔄 showNextDisplay called with reason: ${reason}`);

    // If we were called due to boot completion but still have items in boot queue,
    // don't do anything - the processBootQueue method will handle displaying these items
    if (reason === 'boot_complete' && this.bootDisplayQueue.size > 0) {
      this.logger.info({ bootQueueSize: this.bootDisplayQueue.size }, `[${this.getUserId()}] ⏩ Skipping showNextDisplay - boot queue is being processed`);
      return;
    }

    // Boot screen takes precedence
    if (this.bootingApps.size > 0) {
      this.logger.info({ bootingAppsCount: this.bootingApps.size }, `[${this.getUserId()}] 🚀 Showing boot screen - ${this.bootingApps.size} apps booting`);
      this.updateBootScreen();
      return;
    }

    // Check for throttled requests from other apps that could be shown immediately
    // We'll do this early for all reasons, not just app_stop, since throttled requests are priorities
    if (this.throttledRequests.size > 0 && this.userSession) {
      this.logger.info({ throttledCount: this.throttledRequests.size }, `[${this.getUserId()}] 🔄 Checking throttled requests from apps`);

      // Find the oldest throttled request from an app that's still running
      let oldestRequest: ThrottledRequest | null = null;
      let oldestAppName: string | null = null;

      for (const [appName, request] of this.throttledRequests.entries()) {
        // Skip requests from apps that aren't running
        // if (!this.userSession.activeAppSessions.includes(appName)) {
        if (!this.userSession.runningApps.has(appName)) {
          continue;
        }

        // Check if this is the oldest request we've seen
        if (!oldestRequest || request.timestamp < oldestRequest.timestamp) {
          oldestRequest = request;
          oldestAppName = appName;
        }
      }

      // If we found a valid throttled request, show it immediately
      if (oldestRequest && oldestAppName) {
        this.logger.info({ packageName: oldestAppName }, `[${this.getUserId()}] ✅ Showing throttled display from: ${oldestAppName}`);

        // Process the display request immediately
        this.sendToWebSocket(oldestRequest.activeDisplay.displayRequest, this.userSession.websocket);

        // Update display state
        this.displayState.currentDisplay = oldestRequest.activeDisplay;
        this.lastDisplayTime = Date.now();

        // Remove from throttle queue
        this.throttledRequests.delete(oldestAppName);

        // Trigger any associated duration expiry
        if (oldestRequest.activeDisplay.expiresAt) {
          const timeUntilExpiry = oldestRequest.activeDisplay.expiresAt.getTime() - Date.now();
          setTimeout(() => {
            // Only clear if this display is still showing
            if (this.displayState.currentDisplay === oldestRequest!.activeDisplay) {
              this.showNextDisplay('duration_expired');
            }
          }, timeUntilExpiry);
        }

        return;
      }
    }

    // Check for background app with lock
    if (this.displayState.backgroundLock) {
      const { packageName, expiresAt, lastActiveTime } = this.displayState.backgroundLock;
      const now = Date.now();

      // Check if the app with the lock is still active/running
      // const isLockHolderStillRunning = this.userSession?.activeAppSessions.includes(packageName);
      const isLockHolderStillRunning = this.userSession.runningApps.has(packageName);

      // Check if lock should be released due to inactivity or app being stopped
      if (!isLockHolderStillRunning) {
        this.logger.info({ packageName }, `[${this.getUserId()}] 🔓 Releasing lock because app is no longer running: ${packageName}`);
        this.displayState.backgroundLock = null;
      } else if (now - lastActiveTime > this.LOCK_INACTIVE_TIMEOUT) {
        this.logger.info({ packageName, inactiveTime: now - lastActiveTime }, `[${this.getUserId()}] 🔓 Releasing lock due to inactivity: ${packageName}`);
        this.displayState.backgroundLock = null;
      } else if (expiresAt.getTime() > now) {
        // Lock is still valid and active and app is still running

        // Additional check: if the current call is due to the app stopping,
        // then don't try to keep its display even if it has the lock
        if (reason === 'app_stop' &&
            this.displayState.currentDisplay?.displayRequest.packageName === packageName) {
          this.logger.info({ packageName, reason }, `[${this.getUserId()}] 🔓 App ${packageName} is stopping, releasing lock`);
          this.displayState.backgroundLock = null;
        } else if (this.displayState.currentDisplay?.displayRequest.packageName === packageName) {
          // Check if the current display is still valid/active
          if (this.displayState.currentDisplay &&
              this.hasRemainingDuration(this.displayState.currentDisplay)) {
            this.logger.info({ packageName }, `[${this.getUserId()}] ✅ Lock holder is current display and still valid, keeping it`);
            return;
          } else {
            this.logger.info({ packageName }, `[${this.getUserId()}] 🔓 Lock holder's display is no longer valid, releasing lock`);
            this.displayState.backgroundLock = null;
          }
        }

        // If lock holder isn't displaying, try showing core app
        if (this.displayState.coreAppDisplay &&
          this.hasRemainingDuration(this.displayState.coreAppDisplay)) {
          this.logger.info({ mainApp: this.mainApp }, `[${this.getUserId()}] ✅ Lock holder not displaying, showing core app`);
          if (this.showDisplay(this.displayState.coreAppDisplay)) {
            return;
          }
          // If showing core app failed, continue to next checks
        }
      } else {
        this.logger.info({ packageName, expiryTime: expiresAt.getTime() }, `[${this.getUserId()}] 🔓 Lock expired for ${packageName}, clearing lock`);
        this.displayState.backgroundLock = null;
      }
    }

    // Show core app display if it exists and has remaining duration
    if (this.displayState.coreAppDisplay && this.hasRemainingDuration(this.displayState.coreAppDisplay)) {
      this.logger.info({ mainApp: this.mainApp }, `[${this.getUserId()}] ✅ Showing core app display`);
      this.showDisplay(this.displayState.coreAppDisplay);
      return;
    }

    this.logger.info({}, `[${this.getUserId()}] 🔄 Nothing to show, clearing display`);
    this.clearDisplay('main');
  }

  private canBackgroundAppDisplay(packageName: string): boolean {
    // First check if the app is still running
    // if (!this.userSession || !this.userSession.activeAppSessions.includes(packageName)) {
    if (!this.userSession || !this.userSession.runningApps.has(packageName)) {
      this.logger.info({ packageName }, `[${this.userSession?.userId}] ❌ ${packageName} can't display - app not running`);
      return false;
    }

    // Check if this app already has the background lock
    if (this.displayState.backgroundLock?.packageName === packageName) {
      this.logger.info({ packageName }, `[${this.getUserId()}] 🔒 ${packageName} already has background lock`);
      return true;
    }

    // Check if there's no background lock yet
    if (!this.displayState.backgroundLock) {
      this.logger.info({ packageName }, `[${this.getUserId()}] 🔒 Granting new background lock to ${packageName}`);
      this.displayState.backgroundLock = {
        packageName,
        expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
        lastActiveTime: Date.now()
      };
      return true;
    }

    // Check if the current lock holder is the main app (core/standard app)
    // Background apps should be able to display alongside the core app
    if (this.displayState.backgroundLock.packageName === this.mainApp) {
      this.logger.info({ packageName, mainApp: this.mainApp }, `[${this.getUserId()}] 🔒 Core app has lock, but allowing background app ${packageName} to display`);
      this.displayState.backgroundLock = {
        packageName,
        expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
        lastActiveTime: Date.now()
      };
      return true;
    }

    // Check if the current lock holder is still running
    const lockHolderStillRunning = this.userSession.runningApps.has(
      this.displayState.backgroundLock.packageName
    );

    if (!lockHolderStillRunning) {
      this.logger.info({ packageName, lockHolder: this.displayState.backgroundLock.packageName }, `[${this.getUserId()}] 🔓 Lock holder ${this.displayState.backgroundLock.packageName} is no longer running, releasing lock`);
      this.displayState.backgroundLock = {
        packageName,
        expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
        lastActiveTime: Date.now()
      };
      return true;
    }

    this.logger.info({ packageName, lockHolder: this.displayState.backgroundLock.packageName }, `[${this.getUserId()}] ❌ ${packageName} blocked - lock held by ${this.displayState.backgroundLock.packageName}`);
    return false;
  }

  private updateBootScreen(): void {
    if (!this.userSession || this.bootingApps.size === 0) return;

    const bootingAppNames = Array.from(this.bootingApps).map(packageName => {
      // Get the "name" of the app from looking into the userSession object.
      // const name = this.userSession?.installedApps.find(app => app.packageName === packageName)?.name;
      const name = this.userSession.installedApps.get(packageName)?.name;
      if (name) return name;

      // TODO(isaiah): We can fetch app from db to get the name if it's not in userSession's installedApps.
      return packageName; // Fallback to package name if no name found
    });

    const bootRequest: DisplayRequest = {
      type: TpaToCloudMessageType.DISPLAY_REQUEST,
      view: ViewType.MAIN,
      packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,
      layout: {
        layoutType: LayoutType.REFERENCE_CARD,
        title: `// AugmentOS - Starting App${this.bootingApps.size > 1 ? 's' : ''}`,
        text: bootingAppNames.join(", ")
      },
      timestamp: new Date()
    };

    this.sendDisplay(bootRequest);
  }

  private clearDisplay(viewName: string): void {
    if (!this.userSession) return;

    // Don't clear the display if we're in the middle of processing the boot queue
    // This prevents clearing a display just before a queued display is processed
    if (this.bootDisplayQueue.size > 0) {
      this.logger.info({ bootQueueSize: this.bootDisplayQueue.size }, `[${this.getUserId()}] ⏩ Skipping clear display - boot queue is not empty`);
      return;
    }

    const clearRequest: DisplayRequest = {
      type: TpaToCloudMessageType.DISPLAY_REQUEST,
      view: viewName as ViewType,
      packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,
      layout: {
        layoutType: LayoutType.TEXT_WALL,
        text: ''
      },
      timestamp: new Date(),
      durationMs: 0
    };
    this.logger.info({ viewName }, `[${this.getUserId()}] 🧹 Clearing display for view: ${viewName}`);
    this.sendDisplay(clearRequest);
  }

  /**
   * Checks if a display should still be considered valid/active
   *
   * A display is considered valid when:
   * 1. It has no expiration, OR
   * 2. It has an expiration time that hasn't passed yet
   *
   * Additionally, we consider other factors like:
   * - For displays without expiration, consider them consumed after they've been shown
   * - Short-lived displays (< 1 second) are considered transient and won't be restored
   */
  private hasRemainingDuration(activeDisplay: ActiveDisplay): boolean {
    // If the display has an explicit expiration time, check if it has passed
    if (activeDisplay.expiresAt) {
      return activeDisplay.expiresAt.getTime() > Date.now();
    }

    // Special handling for displays without explicit duration

    // 1. If the display request has a zero duration, it was likely meant to be shown once
    // and should not be restored after a different display is shown
    if (activeDisplay.displayRequest.durationMs === 0) {
      return false;
    }

    // 2. If the display has been shown for more than a few seconds,
    // it's likely been "consumed" by the user and shouldn't be restored
    const displayAge = Date.now() - activeDisplay.startedAt.getTime();
    const MIN_DISPLAY_LIFETIME = 1000; // 1 second

    if (displayAge > MIN_DISPLAY_LIFETIME) {
      return false;
    }

    // Default case - if no expiration and recently shown, consider it valid
    return true;
  }

  private createActiveDisplay(displayRequest: DisplayRequest): ActiveDisplay {
    const now = new Date();
    return {
      displayRequest: displayRequest,
      startedAt: now,
      expiresAt: displayRequest.durationMs ? new Date(now.getTime() + displayRequest.durationMs) : undefined
    };
  }

  private sendDisplay(displayRequest: DisplayRequest): boolean {
    if (!this.userSession) return false;

    // Never throttle dashboard view or boot screen
    const isBootPhase = this.bootingApps.size > 0;
    const isDashboard = displayRequest.view === 'dashboard';

    if (!isDashboard && !isBootPhase && Date.now() - this.lastDisplayTime < this.THROTTLE_DELAY) {
      this.logger.info(`[DisplayManager.service] - [${this.getUserId()}] ⏳ Display throttled, queuing: ${displayRequest.packageName}`);

      const activeDisplay = this.createActiveDisplay(displayRequest);
      // Store in per-app throttle map and schedule processing
      this.enqueueThrottledDisplay(activeDisplay);
      return true;
    }

    const success = this.sendToWebSocket(displayRequest, this.userSession.websocket);
    if (success && !isDashboard && !isBootPhase) {
      this.lastDisplayTime = Date.now();
    }

    return success;
  }

  private sendToWebSocket(displayRequest: DisplayRequest, webSocket?: WebSocket): boolean {
    if (!webSocket || webSocket?.readyState !== 1) {
      this.logger.info({}, `[${this.getUserId()}] ❌ WebSocket not ready`);
      return false;
    }

    try {
      webSocket.send(JSON.stringify(displayRequest));
      return true;
    } catch (error) {
      this.logger.error({ error }, `[${this.getUserId()}] ❌ WebSocket error sending display request`);
      return false;
    }
  }

  // Dispose method to clean up resources.
  public dispose(): void {
    this.logger.info({}, `[${this.userSession?.userId}] 🧹 DisplayManager disposed`);
    this.bootingApps.clear();
    this.bootDisplayQueue.clear();
    this.throttledRequests.clear();
    this.displayState = {
      currentDisplay: null,
      savedDisplayBeforeBoot: null,
      coreAppDisplay: null,
      backgroundLock: null
    };
  }
}

export default DisplayManager;
