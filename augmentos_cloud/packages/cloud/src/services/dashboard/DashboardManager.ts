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
  UserSession
} from '@augmentos/sdk';
import { logger } from '@augmentos/utils';
import { systemApps } from '../core/system-apps';
import { ExtendedUserSession } from '../core/session.service';
import { Logger } from 'pino';

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
  private userSession: ExtendedUserSession;

  // child logger for this manager
  private logger: Logger;// = logger.child({ module: 'DashboardManager', sessionId: this.userSession.sessionId });

  /**
   * Create a new DashboardManager for a specific user session
   * @param userSession The user session this dashboard belongs to
   * @param config Dashboard configuration options
   */
  constructor(userSession: ExtendedUserSession, config: DashboardConfig = {}) {
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

    // Create a child logger for this manager
    this.logger = userSession.logger.child({ module: 'DashboardManager', sessionId: this.userSession.sessionId });
    this.logger.info(`Dashboard Manager initialized for user ${userSession.userId} with mode: ${this.currentMode}`);

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
      this.logger.error('Error handling dashboard message', error);
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
    logger.info(`Cleaned up dashboard content for disconnected TPA: ${packageName}`);
  }

  /**
   * Handle dashboard content update from a TPA
   * @param message Content update message
   */
  public handleDashboardContentUpdate(message: DashboardContentUpdate): void {
    const { packageName, content, modes, timestamp } = message;

    this.logger.debug(`Dashboard content update from ${packageName}`, {
      modes,
      timestamp: new Date(timestamp).toISOString()
    });

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
    if (packageName !== systemApps.dashboard.packageName) {
      this.logger.warn(`Unauthorized dashboard mode change from ${packageName}`);
      return;
    }

    this.logger.info(`Dashboard mode changed to ${mode}`);

    // Update mode
    this.setDashboardMode(mode);
  }

  /**
   * Handle system dashboard content update
   * @param message System dashboard update message
   */
  public handleDashboardSystemUpdate(message: DashboardSystemUpdate): void {
    const { packageName, section, content } = message;

    // Only allow system dashboard to update system sections
    if (packageName !== systemApps.dashboard.packageName) {
      this.logger.warn(`Unauthorized system dashboard update from ${packageName}`);
      return;
    }

    this.logger.debug(`System dashboard update for ${section} from ${packageName}`);

    // Update the appropriate section
    this.systemContent[section] = content;

    // Update the dashboard
    this.updateDashboard();
  }

  /**
   * Update regular dashboard display based on current mode and content
   */
  private updateDashboard(): void {
    this.logger.debug(`🔄 Dashboard update triggered for session ${this.userSession.sessionId}`, {
      currentMode: this.currentMode,
      mainContentCount: this.mainContent.size,
      expandedContentCount: this.expandedContent.size,
      userDatetime: this.userSession.userDatetime
    });
    
    // Skip if mode is none
    if (this.currentMode === 'none') {
      this.logger.debug(`⏭️ Dashboard update skipped - mode is 'none'`);
      return;
    }

    try {
      // Generate layout based on current mode
      let layout: Layout;

      switch (this.currentMode) {
        case DashboardMode.MAIN:
          this.logger.debug(`📊 Generating MAIN dashboard layout`);
          layout = this.generateMainLayout();
          break;
        case DashboardMode.EXPANDED:
          this.logger.debug(`📊 Generating EXPANDED dashboard layout`);
          layout = this.generateExpandedLayout();
          break;
        default:
          this.logger.warn(`⏭️ Unknown dashboard mode: ${this.currentMode}`);
          return;
      }

      // Create a display request for regular dashboard
      const displayRequest: DisplayRequest = {
        type: TpaToCloudMessageType.DISPLAY_REQUEST,
        packageName: systemApps.dashboard.packageName,
        view: ViewType.DASHBOARD,
        layout,
        timestamp: new Date(),
        // We don't set a durationMs to keep it displayed indefinitely
      };

      // Send the display request using the session's DisplayManager
      this.sendDisplayRequest(displayRequest);
    } catch (error) {
      this.logger.error('❌ Error updating dashboard', error);
      
      // Log more details about the current state to help with debugging
      this.logger.error('Dashboard state during error:', {
        currentMode: this.currentMode,
        systemContentIsEmpty: Object.values(this.systemContent).every(v => !v),
        systemContentTopLeft: this.systemContent.topLeft?.substring(0, 20),
        systemContentTopRight: this.systemContent.topRight?.substring(0, 20),
        mainContentCount: this.mainContent.size,
        expandedContentCount: this.expandedContent.size
      });
    }
  }
  
  /**
   * Update the always-on dashboard overlay
   * This runs independently of the regular dashboard views
   */
  private updateAlwaysOnDashboard(): void {
    this.logger.info(`🔄 Always-on dashboard update triggered for session ${this.userSession.sessionId}`, {
      alwaysOnEnabled: this.alwaysOnEnabled,
      alwaysOnContentCount: this.alwaysOnContent.size
    });
    
    // Skip if always-on is disabled
    if (!this.alwaysOnEnabled) {
      this.logger.info(`⏭️ Always-on dashboard update skipped - disabled`);
      return;
    }

    try {
      // Generate always-on layout
      this.logger.info(`📊 Generating ALWAYS_ON dashboard layout`);
      const layout = this.generateAlwaysOnLayout();

      // Create a display request specifically for always-on with the new view type
      const displayRequest: DisplayRequest = {
        type: TpaToCloudMessageType.DISPLAY_REQUEST,
        packageName: systemApps.dashboard.packageName,
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
      this.logger.warn('\n\n⚠️⚠️⚠️⚠️ Always-on dashboard update is not yet implemented in the client. Not sending display request. ⚠️⚠️⚠️⚠️\n\n');
    } catch (error) {
      this.logger.error('❌ Error updating always-on dashboard', error);
      
      // Log more details about the always-on state to help with debugging
      this.logger.error('Always-on dashboard state during error:', {
        alwaysOnEnabled: this.alwaysOnEnabled,
        systemContentTopLeft: this.systemContent.topLeft?.substring(0, 20),
        systemContentTopRight: this.systemContent.topRight?.substring(0, 20),
        alwaysOnContentCount: this.alwaysOnContent.size
      });
    }
  }

  /**
   * Send display request to the associated user session
   * @param displayRequest Display request to send
   */
  private sendDisplayRequest(displayRequest: DisplayRequest): void {
    try {
      // Add detailed logging to track what we're sending
      this.logger.debug(`🔍 Sending dashboard display request to session ${this.userSession.sessionId}`, {
        displayRequest,

      });
      
      // Log the actual content being sent
      if (displayRequest.layout.layoutType === LayoutType.DOUBLE_TEXT_WALL) {
        const layout = displayRequest.layout as any;
        this.logger.debug(`📋 Content for DoubleTextWall:`, {
          leftSide: layout.topText?.substring(0, 50) + (layout.topText?.length > 50 ? '...' : ''),
          rightSide: layout.bottomText?.substring(0, 50) + (layout.bottomText?.length > 50 ? '...' : '')
        });
      } else if (displayRequest.layout.layoutType === LayoutType.TEXT_WALL) {
        const layout = displayRequest.layout as any;
        this.logger.debug(`📋 Content for TextWall:`, {
          text: layout.text?.substring(0, 100) + (layout.text?.length > 100 ? '...' : '')
        });
      } else if (displayRequest.layout.layoutType === LayoutType.DASHBOARD_CARD) {
        const layout = displayRequest.layout as any;
        this.logger.debug(`📋 Content for DashboardCard:`, {
          leftText: layout.leftText?.substring(0, 50) + (layout.leftText?.length > 50 ? '...' : ''),
          rightText: layout.rightText?.substring(0, 50) + (layout.rightText?.length > 50 ? '...' : '')
        });
      }
      
      // Use the DisplayManager to send the display request
      this.userSession.displayManager.handleDisplayEvent(displayRequest, this.userSession);
      this.logger.info(`✅ Successfully sent dashboard display request`);
    } catch (error) {
      this.logger.error(`❌ Error sending dashboard display request`, error);
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
    // Get just the most recent TPA content item for the main dashboard
    // We only want to show one item at a time, not multiple
    const tpaContent = this.getCombinedTpaContent(this.mainContent, 1);

    // If there's system content for the bottom right, add it before TPA content
    // Add topRight system info to the TPA content.
    if (this.systemContent.bottomRight) {
      return tpaContent ? `${this.systemContent.topRight}\n${this.systemContent.bottomRight}\n\n${tpaContent}` : `${this.systemContent.topRight}\n${this.systemContent.bottomRight}`;
    }

    // Add topRight system info to the TPA content.
    return `${this.systemContent.topRight}\n${tpaContent}`;
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
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
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
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
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
    // Check if this TPA had always-on content
    const hadAlwaysOnContent = this.alwaysOnContent.has(packageName);
    
    // Remove from all content queues
    this.mainContent.delete(packageName);
    this.expandedContent.delete(packageName);
    this.alwaysOnContent.delete(packageName);

    // Update the regular dashboard
    this.updateDashboard();
    
    // Update the always-on dashboard separately if needed
    if (hadAlwaysOnContent && this.alwaysOnEnabled) {
      this.updateAlwaysOnDashboard();
    }
    
    this.logger.info(`Cleaned up dashboard content for TPA: ${packageName}`);
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
    
    this.logger.info(`Always-on dashboard ${enabled ? 'enabled' : 'disabled'} for session ${this.userSession.sessionId}`);

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
      this.logger.info(`Clearing always-on dashboard for session ${this.userSession.sessionId}`);
      
      // Send an empty layout to clear the always-on view
      const clearRequest: DisplayRequest = {
        type: TpaToCloudMessageType.DISPLAY_REQUEST,
        packageName: systemApps.dashboard.packageName,
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
      this.userSession.appConnections.forEach((ws, packageName) => {
        try {
          if (ws && ws.readyState === WebSocket.OPEN) {
            const tpaMessage = {
              ...message,
              sessionId: `${this.userSession.sessionId}-${packageName}`
            };
            ws.send(JSON.stringify(tpaMessage));
          }
        } catch (error) {
          this.logger.error(`Error sending dashboard message to TPA ${packageName}`, error);
        }
      });
    } catch (error) {
      this.logger.error(`Error broadcasting dashboard message`, error);
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

    logger.info('Dashboard Manager disposed');
  }
}