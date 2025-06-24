/**
 * Dashboard Manager
 *
 * Manages dashboard content and layouts across the system.
 * The dashboard provides contextual information to users through various modes:
 * - Main: Full dashboard experience with comprehensive information
 * - Expanded: More space for TPA content while maintaining essential info
 * - Always-on: Persistent minimal dashboard overlay on regular content
 */
import {
  DashboardMode,
  Layout,
  DashboardContentUpdate,
  DashboardModeChange,
  DashboardSystemUpdate,
  TpaToCloudMessageType,
  CloudToGlassesMessageType,
  CloudToTpaMessageType,
  LayoutType,
  ViewType,
  DisplayRequest,
  TpaToCloudMessage,
  // UserSession
} from '@mentra/sdk';
import { SYSTEM_DASHBOARD_PACKAGE_NAME } from '../core/app.service';
import { Logger } from 'pino';
import UserSession from '../session/UserSession';

/**
 * Dashboard content from a TPA
 */
interface TpaContent {
  packageName: string;
  content: string | Layout;
  timestamp: Date;
}

/**
 * System dashboard content by section
 */
interface SystemContent {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

/**
 * Dashboard manager configuration
 */
interface DashboardConfig {
  queueSize?: number;
  updateIntervalMs?: number;
  alwaysOnEnabled?: boolean;
  initialMode?: DashboardMode; // Add initial mode option
}

/**
 * Dashboard manager implementation for a single user session
 */
export class DashboardManager {
  // Dashboard state
  private currentMode: DashboardMode | 'none' = 'none';
  private alwaysOnEnabled: boolean = false;

  // Content queues for each mode
  private mainContent: Map<string, TpaContent> = new Map();
  private expandedContent: Map<string, TpaContent> = new Map();
  private alwaysOnContent: Map<string, TpaContent> = new Map();

  // Circular queue tracking for main dashboard
  private mainContentRotationIndex: number = 0;

  // System dashboard content (managed by system.augmentos.dashboard TPA)
  private systemContent: SystemContent = {
    topLeft: '',
    topRight: '',
    bottomLeft: '',
    bottomRight: ''
  };

  // Configuration
  private queueSize: number;
  private updateIntervalMs: number;
  private updateInterval: NodeJS.Timeout | null = null;

  // Reference to the user session this dashboard belongs to
  private userSession: UserSession;

  // child logger for this manager
  private logger: Logger;// = logger.child({ service: 'DashboardManager', sessionId: this.userSession.sessionId });

  /**
   * Create a new DashboardManager for a specific user session
   * @param userSession The user session this dashboard belongs to
   * @param config Dashboard configuration options
   */
  constructor(userSession: UserSession, config: DashboardConfig = {}) {
    // Store reference to user session
    this.userSession = userSession;

    // Set configuration with defaults
    this.queueSize = config.queueSize || 5;
    this.updateIntervalMs = config.updateIntervalMs || 1000 * 45;
    this.alwaysOnEnabled = config.alwaysOnEnabled || false;

    // Initialize mode to the provided value or default to MAIN
    this.currentMode = config.initialMode || DashboardMode.MAIN;

    // Start update interval
    // this.startUpdateInterval();

    this.logger = userSession.logger.child({ service: 'DashboardManager', sessionId: this.userSession.sessionId });
    this.logger.info({ mode: this.currentMode }, `Dashboard Manager initialized for user ${userSession.userId} with mode: ${this.currentMode}`);
  }

  /**
   * Start the update interval for dashboard rendering
   */
  // private startUpdateInterval(): void {
  //   // Clear any existing interval
  //   if (this.updateInterval) {
  //     clearInterval(this.updateInterval);
  //   }

  //   // Create new interval for periodic updates
  //   this.updateInterval = setInterval(() => {
  //     // Update regular dashboard (main/expanded)
  //     this.updateDashboard();

  //     // Always update the always-on dashboard if it's enabled
  //     if (this.alwaysOnEnabled) {
  //       this.updateAlwaysOnDashboard();
  //     }
  //   }, this.updateIntervalMs);
  // }

  /**
   * Process TPA message and route to the appropriate handler
   * This function will be called from WebSocketService
   * @param message TPA message
   * @returns True if the message was handled, false otherwise
   */
  public handleTpaMessage(message: TpaToCloudMessage): boolean {
    this.logger.debug({ message }, `Received TPA message of type ${message.type} for user ${this.userSession.userId}`);
    try {
      switch (message.type) {
        case TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE:
          this.handleDashboardContentUpdate(message as DashboardContentUpdate);
          return true;

        case TpaToCloudMessageType.DASHBOARD_MODE_CHANGE:
          this.handleDashboardModeChange(message as DashboardModeChange);
          return true;

        case TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE:
          this.handleDashboardSystemUpdate(message as DashboardSystemUpdate);
          return true;

        default:
          return false; // Not a dashboard message
      }
    } catch (error) {
      const logger = this.userSession.logger.child({ message });
      logger.error(error, `Error handling dashboard message of type ${message.type} for user ${this.userSession.userId}`);
      return false;
    }
  }

  /**
   * Handle TPA disconnection to clean up dashboard content
   * @param packageName TPA package name
   */
  public handleTpaDisconnected(packageName: string): void {
    // Clean up content when a TPA disconnects
    this.cleanupAppContent(packageName);
    this.logger.info({ packageName }, `Cleaned up dashboard content for disconnected TPA: ${packageName}`);
  }

  /**
   * Handle head-up gesture to cycle through TPA content in main dashboard
   * This method is called from websocket-glasses service when user looks up
   */
  public onHeadsUp(): void {
    // Only cycle content if we're in main dashboard mode
    if (this.currentMode !== DashboardMode.MAIN) {
      this.logger.debug({ currentMode: this.currentMode }, 'Head-up gesture ignored - not in main dashboard mode');
      return;
    }

    // Only cycle if we have multiple TPA content items
    if (this.mainContent.size <= 1) {
      this.logger.debug({
        contentCount: this.mainContent.size
      }, 'Head-up gesture ignored - not enough TPA content to cycle');
      return;
    }

    // Advance to next item in circular queue
    this.mainContentRotationIndex = (this.mainContentRotationIndex + 1) % this.mainContent.size;

    this.logger.info({
      newIndex: this.mainContentRotationIndex,
      totalItems: this.mainContent.size,
      sessionId: this.userSession.sessionId
    }, 'Head-up gesture triggered - cycling to next TPA content');

    // Update the dashboard to show the new content
    this.updateDashboard();
  }

  /**
   * Handle dashboard content update from a TPA
   * @param message Content update message
   */
  public handleDashboardContentUpdate(message: DashboardContentUpdate): void {
    const { packageName, content, modes, timestamp } = message;

    this.logger.debug({
      modes,
      timestamp: new Date(timestamp).toISOString()
    }, `Dashboard content update from ${packageName} for modes [${modes.join(', ')}]`);

    // Track if we need to update the always-on dashboard
    let alwaysOnUpdated = false;

    // Add content to each requested mode's queue
    modes.forEach(mode => {
      switch (mode) {
        case DashboardMode.MAIN:
          this.mainContent.set(packageName, { packageName, content, timestamp });
          break;
        case DashboardMode.EXPANDED:
          this.expandedContent.set(packageName, { packageName, content, timestamp });
          break;
        // case DashboardMode.ALWAYS_ON:
        //   this.alwaysOnContent.set(packageName, { packageName, content, timestamp });
        //   alwaysOnUpdated = true;
        //   break;
      }
    });

    // Update regular dashboard if content for current mode was updated
    if (modes.includes(this.currentMode as DashboardMode)) {
      this.updateDashboard();
    }

    // Update always-on dashboard separately if its content was updated and it's enabled
    if (alwaysOnUpdated && this.alwaysOnEnabled) {
      this.updateAlwaysOnDashboard();
    }
  }

  /**
   * Handle dashboard mode change from system dashboard TPA
   * @param message Mode change message
   */
  public handleDashboardModeChange(message: DashboardModeChange): void {
    const { packageName, mode } = message;

    // Only allow system dashboard to change mode
    if (packageName !== SYSTEM_DASHBOARD_PACKAGE_NAME) {
      this.logger.warn({ packageName }, `Unauthorized dashboard mode change attempt from ${packageName}`);
      return;
    }

    this.logger.info({ mode }, `Dashboard mode changed to ${mode}`);

    // Update mode
    this.setDashboardMode(mode);
  }

  /**
   * Handle system dashboard content update
   * @param message System dashboard update message
   */
  public handleDashboardSystemUpdate(message: DashboardSystemUpdate): void {
    const { packageName, section, content } = message;
    this.logger.debug({
      function: 'handleDashboardSystemUpdate',
      packageName,
      section,
      contentLength: content?.length || 0
    }, `System dashboard section update from ${packageName} for section '${section}'`);

    // Only allow system dashboard to update system sections
    if (packageName !== SYSTEM_DASHBOARD_PACKAGE_NAME) {
      this.logger.warn({ packageName, section }, `Unauthorized system dashboard update attempt for section ${section} from ${packageName}`);
      return;
    }

    this.logger.debug({ section, contentLength: content?.length || 0 }, `System dashboard section '${section}' updated from ${packageName}`);

    // Update the appropriate section
    this.systemContent[section] = content;

    // Update the dashboard
    this.updateDashboard();
  }

  /**
   * Update regular dashboard display based on current mode and content
   */
  private updateDashboard(): void {
    this.logger.debug({
      sessionId: this.userSession.sessionId,
      currentMode: this.currentMode,
      mainContentCount: this.mainContent.size,
      expandedContentCount: this.expandedContent.size,
      userDatetime: this.userSession.userDatetime
    }, 'Dashboard update triggered');

    // Skip if mode is none
    if (this.currentMode === 'none') {
      this.logger.debug({}, `[${this.userSession.userId}] Dashboard update skipped - mode is none`);
      return;
    }

    try {
      // Generate layout based on current mode
      let layout: Layout;

      switch (this.currentMode) {
        case DashboardMode.MAIN:
          this.logger.debug({}, `[${this.userSession.userId}] Generating MAIN dashboard layout`);
          layout = this.generateMainLayout();
          break;
        case DashboardMode.EXPANDED:
          this.logger.debug({}, `[${this.userSession.userId}] Generating EXPANDED dashboard layout`);
          layout = this.generateExpandedLayout();
          break;
        default:
          this.logger.warn({ mode: this.currentMode }, `[${this.userSession.userId}] Unknown dashboard mode: ${this.currentMode}`);
          return;
      }

      // Create a display request for regular dashboard
      const displayRequest: DisplayRequest = {
        type: TpaToCloudMessageType.DISPLAY_REQUEST,
        packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,
        view: ViewType.DASHBOARD,
        layout,
        timestamp: new Date(),
        // We don't set a durationMs to keep it displayed indefinitely
      };

      // Send the display request using the session's DisplayManager
      this.sendDisplayRequest(displayRequest);
    } catch (error) {
      const logger = this.userSession.logger.child({
        currentMode: this.currentMode,
        systemContentIsEmpty: Object.values(this.systemContent).every(v => !v),
        systemContentTopLeft: this.systemContent.topLeft?.substring(0, 20),
        systemContentTopRight: this.systemContent.topRight?.substring(0, 20),
        mainContentCount: this.mainContent.size,
        expandedContentCount: this.expandedContent.size
      });
      this.logger.error(error, 'Error updating dashboard for user session ' + this.userSession.userId);
    }
  }

  /**
   * Update the always-on dashboard overlay
   * This runs independently of the regular dashboard views
   */
  private updateAlwaysOnDashboard(): void {
    this.logger.info({
      sessionId: this.userSession.sessionId,
      alwaysOnEnabled: this.alwaysOnEnabled,
      alwaysOnContentCount: this.alwaysOnContent.size
    }, 'Always-on dashboard update triggered');

    // Skip if always-on is disabled
    if (!this.alwaysOnEnabled) {
      this.logger.info({}, `[${this.userSession.userId}] Always-on dashboard update skipped - disabled`);
      return;
    }

    try {
      // Generate always-on layout
      this.logger.info({}, `[${this.userSession.userId}] Generating ALWAYS_ON dashboard layout`);
      const layout = this.generateAlwaysOnLayout();

      // Create a display request specifically for always-on with the new view type
      const displayRequest: DisplayRequest = {
        type: TpaToCloudMessageType.DISPLAY_REQUEST,
        packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,
        view: ViewType.ALWAYS_ON,  // Use the new view type
        layout,
        timestamp: new Date(),
        // We don't set a durationMs to keep it displayed indefinitely
      };

      // TODO: if we send this now, it would constantly clear screen an override what the display manager is sending.
      // The client should take this always on dashboard, and combine it with the main view display requests from the display manaer.
      // To build what the user sees.

      // Send the display request using the session's DisplayManager
      // this.sendDisplayRequest(displayRequest);
      // this.logger.info(`✅ Always-on dashboard updated successfully`);
      this.logger.warn({}, 'Always-on dashboard update is not yet implemented in the client');
    } catch (error) {
      const logger = this.userSession.logger.child({
        alwaysOnEnabled: this.alwaysOnEnabled,
        systemContentTopLeft: this.systemContent.topLeft,
        systemContentTopRight: this.systemContent.topRight,
        alwaysOnContentCount: this.alwaysOnContent.size
      });
      logger.error(error, 'Error updating always-on dashboard for user session ' + this.userSession.userId);;
    }
  }

  /**
   * Send display request to the associated user session
   * @param displayRequest Display request to send
   */
  private sendDisplayRequest(displayRequest: DisplayRequest): void {
    try {
      // Add detailed logging to track what we're sending
      this.logger.debug({
        sessionId: this.userSession.sessionId,
        packageName: displayRequest.packageName,
        layoutType: displayRequest.layout.layoutType,
        view: displayRequest.view
      }, `Sending display request for user: ${this.userSession.userId}, package: ${displayRequest.packageName}, view: ${displayRequest.view}`);

      // Log the actual content being sent
      if (displayRequest.layout.layoutType === LayoutType.DOUBLE_TEXT_WALL) {
        const layout = displayRequest.layout as any;
        this.logger.debug({
          leftSide: layout.topText?.substring(0, 50) + (layout.topText?.length > 50 ? '...' : ''),
          rightSide: layout.bottomText?.substring(0, 50) + (layout.bottomText?.length > 50 ? '...' : '')
        }, `Content for DoubleTextWall layout for user: ${this.userSession.userId} package: ${displayRequest.packageName}`);
      } else if (displayRequest.layout.layoutType === LayoutType.TEXT_WALL) {
        const layout = displayRequest.layout as any;
        this.logger.debug({
          text: layout.text?.substring(0, 100) + (layout.text?.length > 100 ? '...' : '')
        }, 'Content for TextWall');
      } else if (displayRequest.layout.layoutType === LayoutType.DASHBOARD_CARD) {
        const layout = displayRequest.layout as any;
        this.logger.debug({
          leftText: layout.leftText?.substring(0, 50) + (layout.leftText?.length > 50 ? '...' : ''),
          rightText: layout.rightText?.substring(0, 50) + (layout.rightText?.length > 50 ? '...' : '')
        }, 'Content for DashboardCard');
      }

      // Use the DisplayManager to send the display request
      const sent = this.userSession.displayManager.handleDisplayRequest(displayRequest);
      if (!sent) {
        this.logger.warn({ displayRequest }, `Display request not sent - DisplayManager is not ready for user: ${this.userSession.userId}`);
        return;
      }

      // Log successful sending
      this.logger.debug({ packageName: displayRequest.packageName }, `Display request sent successfully for user: ${this.userSession.userId}, package ${displayRequest.packageName}`);
    } catch (error) {
      const logger = this.userSession.logger.child({ displayRequest, packageName: displayRequest.packageName });
      logger.error(error, 'Error sending dashboard display request');
    }
  }

  /**
   * Generate layout for main dashboard mode
   * @returns Layout for main dashboard
   */
  private generateMainLayout(): Layout {
    // Format the top section (combine system info and notifications)
    const leftText = this.formatSystemLeftSection();

    // Format the bottom section (combine system info and TPA content)
    const rightText = this.formatSystemRightSection();

    // Return a DoubleTextWall layout for compatibility with existing system
    return {
      layoutType: LayoutType.DOUBLE_TEXT_WALL,
      topText: leftText,
      bottomText: rightText
    };
  }

  /**
   * Format the top section of the dashboard (system info and notifications)
   * @returns Formatted top section text
   */
  private formatSystemLeftSection(): string {
    // First line: Time and battery status on the same line
    const systemLine = `${this.systemContent.topLeft}`;

    // If there's notification content, add it after system info
    if (this.systemContent.bottomLeft) {
      return `${systemLine}\n${this.systemContent.bottomLeft}`;
    }

    return systemLine;
  }

  /**
   * Format the bottom section of the dashboard (system info and TPA content)
   * @returns Formatted bottom section text
   */
  private formatSystemRightSection(): string {
    // Get the next TPA content item using circular rotation for the main dashboard
    // We only want to show one item at a time, cycling through all available content
    const tpaContent = this.getNextMainTpaContent();

    // If there's system content for the bottom right, add it before TPA content
    // Add topRight system info to the TPA content.
    if (this.systemContent.bottomRight) {
      return tpaContent ? `${this.systemContent.topRight}\n${this.systemContent.bottomRight}\n\n${tpaContent}` : `${this.systemContent.topRight}\n${this.systemContent.bottomRight}`;
    }

    // Add topRight system info to the TPA content.
    return `${this.systemContent.topRight}\n${tpaContent}`;
  }

  /**
   * Get the next TPA content for main dashboard using circular queue rotation
   * This method implements the circular queue logic for cycling through TPA content
   * @returns Next TPA content string, or empty string if no content available
   */
  private getNextMainTpaContent(): string {
    // Get all available TPA content as an array
    const contentArray = Array.from(this.mainContent.values());

    // Handle empty case
    if (contentArray.length === 0) {
      return '';
    }

    // Handle single item case - no need to rotate
    if (contentArray.length === 1) {
      return this.extractTextFromContent(contentArray[0].content);
    }

    // Sort by timestamp to ensure consistent ordering (newest first for stable rotation)
    // Handle both Date objects and timestamp numbers
    contentArray.sort((a, b) => {
      const aTime = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
      const bTime = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
      return bTime - aTime;
    });

    // Use circular queue logic with rotation index
    const currentIndex = this.mainContentRotationIndex % contentArray.length;
    const selectedContent = contentArray[currentIndex];

    this.logger.info({
      totalItems: contentArray.length,
      currentIndex,
      selectedPackage: selectedContent.packageName,
      rotationIndex: this.mainContentRotationIndex,
      allPackages: contentArray.map(c => c.packageName),
      sortedByTimestamp: contentArray.map(c => ({
        packageName: c.packageName,
        timestamp: c.timestamp
      }))
    }, `🔄 Dashboard rotation: Selected ${selectedContent.packageName} (${currentIndex + 1}/${contentArray.length})`);

    // Extract text content from the selected item
    return this.extractTextFromContent(selectedContent.content);
  }

  /**
   * Extract text content from TPA content (handles both string and Layout types)
   * @param content TPA content (string or Layout)
   * @returns Extracted text string
   */
  private extractTextFromContent(content: string | Layout): string {
    if (typeof content === 'string') {
      return content;
    }

    // Handle Layout content types
    switch (content.layoutType) {
      case LayoutType.TEXT_WALL:
        return content.text || '';
      case LayoutType.DOUBLE_TEXT_WALL:
        return [content.topText, content.bottomText]
          .filter(Boolean)
          .join('\n');
      case LayoutType.DASHBOARD_CARD:
        return [content.leftText, content.rightText]
          .filter(Boolean)
          .join(' | ');
      case LayoutType.REFERENCE_CARD:
        return `${content.title}\n${content.text}`;
      default:
        return '';
    }
  }

  /**
   * Generate layout for expanded dashboard mode
   * @returns Layout for expanded dashboard
   */
  private generateExpandedLayout(): Layout {
    // For expanded view we use TextWall with manual formatting

    // Create first line with system info (top-left and top-right)
    const systemInfoLine = `${this.systemContent.topLeft} | ${this.systemContent.topRight}`;

    // Get TPA content from expanded content queue (only the most recent item)
    const content = Array.from(this.expandedContent.values())
      .sort((a, b) => {
        const aTime = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
        const bTime = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
        return bTime - aTime;
      })
      .slice(0, 1)[0];

    // Get text content (will always be a string now)
    const tpaContent = content ? content.content as string : '';

    // Combine system info and TPA content with a line break
    const fullText = tpaContent
      ? `${systemInfoLine}\n${tpaContent}`
      : `${systemInfoLine}\nNo expanded content available`;

    // Return a TextWall layout for expanded mode
    return {
      layoutType: LayoutType.TEXT_WALL,
      text: fullText
    };
  }

  /**
   * Generate layout for always-on dashboard mode
   * @returns Layout for always-on dashboard
   */
  private generateAlwaysOnLayout(): Layout {
    // For always-on mode, we use a LayoutType.REFERENCE_CARD
    // I think just the title is used for the persistent display.
    // This is more compact and suited for persistent display

    // Left side shows essential system info (time)
    // const leftText = this.systemContent.topLeft; // currently it seems the client already ads this info.
    // TODO: or if it doesn't we should add the time and battery info before the tpa content.

    // Right side combines battery status and a single TPA content item
    const tpaContent = this.getCombinedTpaContent(this.alwaysOnContent, 1);

    return {
      layoutType: LayoutType.TEXT_WALL,
      text: tpaContent
      // title: `${leftText} | ${tpaContent}`,
    };
  }

  /**
   * Combine TPA content from a queue into a single string
   * @param contentQueue Queue of TPA content
   * @param limit Optional limit on number of items to include
   * @returns Combined content string
   */
  private getCombinedTpaContent(contentQueue: Map<string, TpaContent>, limit?: number): string {
    // Sort by timestamp (newest first)
    const sortedContent = Array.from(contentQueue.values())
      .sort((a, b) => {
        const aTime = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
        const bTime = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
        return bTime - aTime;
      })
      .slice(0, limit || this.queueSize);

    // If no content, return empty string
    if (sortedContent.length === 0) {
      return '';
    }

    // For expanded dashboard, content is now guaranteed to be a string
    // For main or always-on, we'll still handle the legacy logic
    if (limit === 1 && sortedContent.length === 1) {
      const item = sortedContent[0];

      // For expanded content, it will always be a string
      if (this.currentMode === DashboardMode.EXPANDED) {
        return item.content as string;
      }

      // For other modes, continue supporting existing format
      if (typeof item.content === 'string') {
        return item.content;
      } else {
        // For Layout content, extract the text based on the layout type
        switch (item.content.layoutType) {
          case LayoutType.TEXT_WALL:
            return item.content.text || '';
          case LayoutType.DOUBLE_TEXT_WALL:
            return [item.content.topText, item.content.bottomText]
              .filter(Boolean)
              .join('\n');
          case LayoutType.DASHBOARD_CARD:
            return [item.content.leftText, item.content.rightText]
              .filter(Boolean)
              .join(' | ');
          case LayoutType.REFERENCE_CARD:
            return `${item.content.title}\n${item.content.text}`;
          default:
            return '';
        }
      }
    }

    // For multiple items, join them with separators
    // For expanded dashboard, all content will be strings
    if (this.currentMode === DashboardMode.EXPANDED) {
      return sortedContent
        .map(item => item.content as string)
        .join('\n\n');
    }

    // For other modes, continue supporting existing format
    return sortedContent
      .map(item => {
        if (typeof item.content === 'string') {
          return item.content;
        } else {
          // For Layout content, extract the text based on the layout type
          switch (item.content.layoutType) {
            case LayoutType.TEXT_WALL:
              return item.content.text || '';
            case LayoutType.DOUBLE_TEXT_WALL:
              return [item.content.topText, item.content.bottomText]
                .filter(Boolean)
                .join('\n');
            case LayoutType.DASHBOARD_CARD:
              return [item.content.leftText, item.content.rightText]
                .filter(Boolean)
                .join(' | ');
            case LayoutType.REFERENCE_CARD:
              return `${item.content.title}\n${item.content.text}`;
            default:
              return '';
          }
        }
      })
      .join('\n\n');
  }

  /**
   * Clean up content from a specific TPA
   * @param packageName TPA package name
   */
  public cleanupAppContent(packageName: string): void {
    // Log the current state before cleanup
    const beforeState = {
      packageName,
      hadMainContent: this.mainContent.has(packageName),
      hadExpandedContent: this.expandedContent.has(packageName),
      hadAlwaysOnContent: this.alwaysOnContent.has(packageName),
      mainContentSizeBefore: this.mainContent.size,
      rotationIndexBefore: this.mainContentRotationIndex,
      allMainContentPackages: Array.from(this.mainContent.keys())
    };

    this.logger.info(beforeState, `🧹 Starting dashboard cleanup for TPA: ${packageName}`);

    // Check if this TPA had always-on content
    const hadAlwaysOnContent = this.alwaysOnContent.has(packageName);

    // Check if this TPA was in main content and adjust rotation index if needed
    const hadMainContent = this.mainContent.has(packageName);
    const mainContentSizeBefore = this.mainContent.size;

    // Remove from all content queues
    this.mainContent.delete(packageName);
    this.expandedContent.delete(packageName);
    this.alwaysOnContent.delete(packageName);

    // Adjust rotation index if we removed main content
    if (hadMainContent && mainContentSizeBefore > 1) {
      const newMainContentSize = this.mainContent.size;
      const oldRotationIndex = this.mainContentRotationIndex;

      // If we removed the currently displayed item or an item before it in the rotation,
      // we need to adjust the index to prevent out-of-bounds access
      if (newMainContentSize > 0) {
        // Reset to 0 if index is now out of bounds, otherwise keep current position
        if (this.mainContentRotationIndex >= newMainContentSize) {
          this.mainContentRotationIndex = 0;
          this.logger.debug({
            oldIndex: oldRotationIndex,
            newIndex: 0,
            newSize: newMainContentSize,
            removedPackage: packageName
          }, 'Reset rotation index after TPA disconnect');
        }
      } else {
        // No content left, reset index
        this.mainContentRotationIndex = 0;
      }
    }

    // Update the regular dashboard
    this.updateDashboard();

    // Update the always-on dashboard separately if needed
    if (hadAlwaysOnContent && this.alwaysOnEnabled) {
      this.updateAlwaysOnDashboard();
    }

    // Log the final state after cleanup
    const afterState = {
      packageName,
      newMainContentSize: this.mainContent.size,
      rotationIndexAfter: this.mainContentRotationIndex,
      remainingMainContentPackages: Array.from(this.mainContent.keys()),
      hadMainContent,
      hadAlwaysOnContent
    };

    this.logger.info(afterState, `✅ Dashboard cleanup completed for TPA: ${packageName}`);
  }

  /**
   * Set the current dashboard mode and notify clients
   * @param mode New dashboard mode
   */
  private setDashboardMode(mode: DashboardMode): void {
    // Update current mode
    this.currentMode = mode;

    // Notify TPAs of mode change
    const modeChangeMessage = {
      type: CloudToTpaMessageType.DASHBOARD_MODE_CHANGED,
      mode,
      timestamp: new Date()
    };

    // Broadcast mode change to all connected TPAs
    this.broadcastToAllTpas(modeChangeMessage);

    // Update the dashboard
    this.updateDashboard();
  }

  /**
   * Set the always-on dashboard state
   * @param enabled Whether always-on dashboard is enabled
   */
  public setAlwaysOnEnabled(enabled: boolean): void {
    // Update state
    this.alwaysOnEnabled = enabled;

    this.logger.info({ enabled, sessionId: this.userSession.sessionId }, `Always-on dashboard ${enabled ? 'enabled' : 'disabled'}`);

    // Notify TPAs of state change
    const alwaysOnMessage = {
      type: CloudToTpaMessageType.DASHBOARD_ALWAYS_ON_CHANGED,
      enabled,
      timestamp: new Date()
    };

    // Broadcast always-on state change to all connected TPAs
    this.broadcastToAllTpas(alwaysOnMessage);

    // Update the regular dashboard
    this.updateDashboard();

    // If enabled, update the always-on dashboard immediately
    if (enabled) {
      this.updateAlwaysOnDashboard();
    } else {
      // If disabled, send a clear command for the always-on view
      // This ensures the always-on dashboard is removed from display
      this.logger.info({ sessionId: this.userSession.sessionId }, 'Clearing always-on dashboard');

      // Send an empty layout to clear the always-on view
      const clearRequest: DisplayRequest = {
        type: TpaToCloudMessageType.DISPLAY_REQUEST,
        packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,
        view: ViewType.ALWAYS_ON,
        layout: {
          layoutType: LayoutType.DASHBOARD_CARD,
          leftText: '',
          rightText: ''
        },
        timestamp: new Date(),
        durationMs: 0  // Clear immediately
      };

      this.sendDisplayRequest(clearRequest);
    }
  }

  /**
   * Broadcast a message to all TPAs connected to this user session
   * @param message Message to broadcast
   */
  private broadcastToAllTpas(message: any): void {
    try {
      // Use the appConnections map to send to all connected TPAs
      // this.userSession.appConnections.forEach((ws, packageName) => {
      this.userSession.appWebsockets.forEach((ws, packageName) => {
        try {
          if (ws && ws.readyState === WebSocket.OPEN) {
            const tpaMessage = {
              ...message,
              sessionId: `${this.userSession.sessionId}-${packageName}`
            };
            ws.send(JSON.stringify(tpaMessage));
          }
        } catch (error) {
          const logger = this.userSession.logger.child({ packageName, message });
          logger.error(error, 'Error sending dashboard message to TPA');
        }
      });
    } catch (error) {
      const logger = this.userSession.logger.child({ message });
      this.logger.error(error, 'Error broadcasting dashboard message');
    }
  }

  /**
   * Get the current dashboard mode
   * @returns Current dashboard mode
   */
  public getCurrentMode(): DashboardMode | 'none' {
    return this.currentMode;
  }

  /**
   * Check if always-on dashboard is enabled
   * @returns Always-on dashboard state
   */
  public isAlwaysOnEnabled(): boolean {
    return this.alwaysOnEnabled;
  }

  /**
   * Clean up resources when shutting down
   */
  public dispose(): void {
    // Clear update interval
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Clear all content
    this.mainContent.clear();
    this.expandedContent.clear();
    this.alwaysOnContent.clear();

    this.logger.info({}, 'Dashboard Manager disposed');
  }
}