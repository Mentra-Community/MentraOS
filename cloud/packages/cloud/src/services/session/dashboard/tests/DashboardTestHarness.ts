/**
 * Dashboard Test Harness
 *
 * A testing framework for the dashboard system.
 * Simulates the display manager and WebSocket service to test dashboard functionality.
 */
import {
  DashboardMode,
  Layout,
  AppToCloudMessageType,
  DashboardContentUpdate,
  DashboardModeChange,
  DashboardSystemUpdate,
  LayoutType,
  ViewType
} from '@mentra/sdk';
import { logger  } from '../../../logging/pino-logger';
import { DashboardManager } from '../DashboardManager';

// Mock display manager
class MockDisplayManager {
  private currentLayout: Layout | null = null;
  private displayOptions: any = {};

  constructor(private terminalOutput = true) {}

  show(packageName: string, layout: Layout, options: any = {}): void {
    this.currentLayout = layout;
    this.displayOptions = options;

    if (this.terminalOutput) {
      this.renderLayoutToTerminal(layout, options);
    }
  }

  private renderLayoutToTerminal(layout: Layout, options: any): void {
    const viewType = options.view || 'main';
    console.log(`\n=== ${layout.layoutType} (View: ${viewType}) ===`);

    // Render based on layout type
    switch (layout.layoutType) {
      case LayoutType.DOUBLE_TEXT_WALL:
        console.log(`[topText]: ${layout.topText}`);
        console.log(`[bottomText]: ${layout.bottomText}`);
        break;

      case LayoutType.DASHBOARD_CARD:
        console.log(`[leftText]: ${layout.leftText}`);
        console.log(`[rightText]: ${layout.rightText}`);
        break;

      case LayoutType.TEXT_WALL:
        console.log(`[text]: ${layout.text}`);
        break;

      case LayoutType.REFERENCE_CARD:
        console.log(`[title]: ${layout.title}`);
        console.log(`[text]: ${layout.text}`);
        break;

      default:
        console.log('Unknown layout type');
        console.log(JSON.stringify(layout, null, 2));
    }

    console.log('================\n');
  }

  getCurrentLayout(): Layout | null {
    return this.currentLayout;
  }

  getDisplayOptions(): any {
    return this.displayOptions;
  }

  // Add handleDisplayEvent for DashboardManager compatibility
  handleDisplayEvent(displayRequest: any, userSession: any): boolean {
    // Store the layout and options
    this.currentLayout = displayRequest.layout;
    this.displayOptions = {
      view: displayRequest.view,
      ...displayRequest
    };
    // Optionally render to terminal
    this.show(displayRequest.packageName, displayRequest.layout, { view: displayRequest.view });
    return true;
  }
}

// Mock WebSocket service
class MockWebSocketService {
  private appMessageHandlers: Map<string, Function> = new Map();
  private appDisconnectHandlers: Function[] = [];
  private glassesMessages: any[] = [];
  private appMessages: any[] = [];

  registerAppMessageHandler(type: string, handler: Function): void {
    this.appMessageHandlers.set(type, handler);
  }

  onAppDisconnected(handler: Function): void {
    this.appDisconnectHandlers.push(handler);
  }

  broadcastToGlasses(message: any): void {
    this.glassesMessages.push(message);
    console.log('Message to glasses:', message);
  }

  broadcastToApps(message: any): void {
    this.appMessages.push(message);
    console.log('Message to Apps:', message);
  }

  // Test methods
  simulateAppMessage(message: any): void {
    const type = message.type;
    const handler = this.appMessageHandlers.get(type);

    if (handler) {
      handler(message);
    } else {
      console.warn(`No handler registered for message type: ${type}`);
    }
  }

  simulateAppDisconnect(packageName: string): void {
    this.appDisconnectHandlers.forEach(handler => {
      handler(packageName);
    });
  }

  getGlassesMessages(): any[] {
    return this.glassesMessages;
  }

  getAppMessages(): any[] {
    return this.appMessages;
  }

  clearMessages(): void {
    this.glassesMessages = [];
    this.appMessages = [];
  }
}

// Local constant for dashboard package name
const DASHBOARD_PACKAGE_NAME = process.env.SYSTEM_DASHBOARD_PACKAGE_NAME || 'system.augmentos.dashboard';

/**
 * Dashboard test harness
 */
export class DashboardTestHarness {
  private displayManager: MockDisplayManager;
  private wsService: MockWebSocketService;
  private dashboardManager: DashboardManager;

  constructor() {
    this.displayManager = new MockDisplayManager();
    this.wsService = new MockWebSocketService();

    // Create a mock userSession object with required properties
    const mockUserSession = {
      sessionId: 'test-session-id',
      userId: 'test-user',
      logger: logger.child({ service: 'DashboardManager', sessionId: 'test-session-id' }),
      displayManager: this.displayManager,
      appConnections: new Map(),
      userDatetime: '2025-05-26T05:35:40.141Z'
    };
    this.dashboardManager = new DashboardManager(
      mockUserSession as any,
      {
        updateIntervalMs: 100, // Faster updates for testing
        queueSize: 3
      }
    );

    // Register DashboardManager handlers with the mock WebSocket service
    this.wsService.registerAppMessageHandler(
      AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
      (msg: any) => this.dashboardManager.handleAppMessage(msg)
    );
    this.wsService.registerAppMessageHandler(
      AppToCloudMessageType.DASHBOARD_MODE_CHANGE,
      (msg: any) => this.dashboardManager.handleAppMessage(msg)
    );
    this.wsService.registerAppMessageHandler(
      AppToCloudMessageType.DASHBOARD_SYSTEM_UPDATE,
      (msg: any) => this.dashboardManager.handleAppMessage(msg)
    );
    this.wsService.onAppDisconnected((packageName: string) => this.dashboardManager.handleAppDisconnected(packageName));

    logger.info('Dashboard Test Harness initialized');
  }

  /**
   * Send content from a regular App to the dashboard
   */
  sendAppContent(packageName: string, content: string, modes: DashboardMode[] = [DashboardMode.MAIN]): void {
    const message: DashboardContentUpdate = {
      type: AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
      packageName,
      content,
      modes,
      timestamp: new Date(),
      sessionId: 'test-session-id'
    };

    this.wsService.simulateAppMessage(message);
  }

  /**
   * Update system dashboard section
   */
  updateSystemSection(section: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight', content: string): void {
    const message: DashboardSystemUpdate = {
      type: AppToCloudMessageType.DASHBOARD_SYSTEM_UPDATE,
      packageName: DASHBOARD_PACKAGE_NAME,
      section,
      content,
      timestamp: new Date(),
      sessionId: 'test-session-id'
    };

    this.wsService.simulateAppMessage(message);
  }

  /**
   * Change dashboard mode
   */
  changeDashboardMode(mode: DashboardMode): void {
    const message: DashboardModeChange = {
      type: AppToCloudMessageType.DASHBOARD_MODE_CHANGE,
      packageName: DASHBOARD_PACKAGE_NAME,
      mode,
      timestamp: new Date(),
      sessionId: 'test-session-id'
    };

    this.wsService.simulateAppMessage(message);
  }

  /**
   * Simulate a App disconnecting
   */
  disconnectApp(packageName: string): void {
    this.wsService.simulateAppDisconnect(packageName);
  }

  /**
   * Set always-on dashboard state
   */
  setAlwaysOnEnabled(enabled: boolean): void {
    this.dashboardManager.setAlwaysOnEnabled(enabled);
  }

  /**
   * Get current dashboard mode
   */
  getCurrentMode(): DashboardMode | 'none' {
    return this.dashboardManager.getCurrentMode();
  }

  /**
   * Get current dashboard layout
   */
  getCurrentLayout(): Layout | null {
    return this.displayManager.getCurrentLayout();
  }

  /**
   * Run basic test scenario
   */
  runBasicTest(): void {
    console.log('=== RUNNING BASIC DASHBOARD TEST ===');

    // Initialize system dashboard sections
    this.updateSystemSection('topLeft', 'Time: 12:34');
    this.updateSystemSection('topRight', 'Battery: 85%');
    this.updateSystemSection('bottomLeft', 'Notifications: 3');
    this.updateSystemSection('bottomRight', 'Status: Connected');

    // Set dashboard mode to MAIN
    this.changeDashboardMode(DashboardMode.MAIN);

    // Send content from multiple Apps
    this.sendAppContent('com.example.weather', 'Weather: Sunny, 72°F');
    this.sendAppContent('com.example.calendar', 'Meeting with Team @ 1:00 PM');
    this.sendAppContent('com.example.messages', 'New message from John: "Are we still on for lunch?"');

    // Change to expanded mode
    setTimeout(() => {
      console.log('\n>>> Changing to EXPANDED mode');
      this.changeDashboardMode(DashboardMode.EXPANDED);

      // Send expanded content
      this.sendAppContent('com.example.tasks', 'Current tasks:\n- Finish dashboard implementation\n- Test with glasses\n- Write documentation', [DashboardMode.EXPANDED]);
    }, 1000);

    // Change to always-on mode
    // setTimeout(() => {
    //   console.log('\n>>> Changing to ALWAYS-ON mode');
    //   // this.changeDashboardMode(DashboardMode.ALWAYS_ON); // Commented out, not in enum
    //   // Send always-on content
    //   // this.sendAppContent('com.example.fitness', 'Steps: 5,280', [DashboardMode.ALWAYS_ON]);
    // }, 2000);

    // Test always-on overlay
    setTimeout(() => {
      console.log('\n>>> Enabling ALWAYS-ON overlay with MAIN mode');
      this.changeDashboardMode(DashboardMode.MAIN);
      this.setAlwaysOnEnabled(true);
    }, 3000);

    // Test App disconnect
    setTimeout(() => {
      console.log('\n>>> Disconnecting a App');
      this.disconnectApp('com.example.messages');
    }, 4000);

    // End test
    setTimeout(() => {
      console.log('\n=== BASIC DASHBOARD TEST COMPLETE ===');
    }, 5000);
  }

  /**
   * Run app lifecycle test scenario
   */
  runAppLifecycleTest(): void {
    console.log('=== RUNNING APP LIFECYCLE TEST ===');

    // Set up initial state
    this.updateSystemSection('topLeft', 'Time: 15:45');
    this.updateSystemSection('topRight', 'Battery: 72%');
    this.changeDashboardMode(DashboardMode.MAIN);

    // Add content from multiple Apps
    console.log('\n>>> Starting apps and adding content');
    this.sendAppContent('app1', 'App 1 Content');
    this.sendAppContent('app2', 'App 2 Content');
    this.sendAppContent('app3', 'App 3 Content');

    // Simulate app updates
    setTimeout(() => {
      console.log('\n>>> Updating app content');
      this.sendAppContent('app1', 'App 1 Updated Content');
      this.sendAppContent('app3', 'App 3 Updated Content');
    }, 1000);

    // Simulate app stopping
    setTimeout(() => {
      console.log('\n>>> Stopping app2');
      this.disconnectApp('app2');
    }, 2000);

    // Add new app
    setTimeout(() => {
      console.log('\n>>> Starting app4');
      this.sendAppContent('app4', 'App 4 Content');
    }, 3000);

    // Stop all apps
    setTimeout(() => {
      console.log('\n>>> Stopping all apps');
      this.disconnectApp('app1');
      this.disconnectApp('app3');
      this.disconnectApp('app4');
    }, 4000);

    // End test
    setTimeout(() => {
      console.log('\n=== APP LIFECYCLE TEST COMPLETE ===');
    }, 5000);
  }

  /**
   * Run notification test scenario (user-provided test case)
   * Now: Only test NotificationSummaryAgent and output the ranking
   */
  async runNotificationTest(): Promise<void> {
    console.log('=== RUNNING NOTIFICATION SUMMARY AGENT TEST ===');

    // Import NotificationSummaryAgent
    const { NotificationSummaryAgent } = await import('@mentra/agents');
    const agent = new NotificationSummaryAgent();

    // Notification data (from previous test)
    const notifications = [
      {
        title: 'WhatsApp',
        content: '来自2个对话的‎3条消息条消息',
        timestamp: new Date('2025-05-26T05:35:40.141Z'),
        uuid: 'ff685639-8d6b-43df-bd74-06fdd2d00b70',
        appName: 'WhatsApp',
        text: '来自2个对话的‎3条消息条消息',
        seenCount: 0
      },
      {
        title: '妈妈',
        content: '对"Thanks"留下了心情❤️',
        timestamp: new Date('2025-05-26T05:37:59.774Z'),
        uuid: 'd1328f14-3457-4ba2-a41c-2d029224108b',
        appName: 'WhatsApp',
        text: '对"Thanks"留下了心情❤️',
        seenCount: 0
      },
      {
        title: 'Mentra <> Auki：Cayden Pierce',
        content:
          "I'll come around Sunday or monday or so, tbd but I'll let you guys know",
        timestamp: new Date('2025-05-26T05:37:59.781Z'),
        uuid: '975c9fcf-9ac1-476c-bf26-d9afd1d6efb1',
        appName: 'WhatsApp',
        text: "I'll come around Sunday or monday or so, tbd but I'll let you guys know",
        seenCount: 0
      },
      {
        title: 'WhatsApp',
        content: '来自2个对话的‎3条消息条消息',
        timestamp: new Date('2025-05-26T05:37:59.788Z'),
        uuid: 'fa09f9be-6934-43c1-8bb3-558f09f63ba2',
        appName: 'WhatsApp',
        text: '来自2个对话的‎3条消息条消息',
        seenCount: 0
      },
      {
        title: '‎Mentra <> Auki (2条消息)：Cayden Pierce',
        content: 'Will stay in camlux',
        timestamp: new Date('2025-05-26T05:38:00.267Z'),
        uuid: 'ab003049-c251-47ed-9257-9bc5e85b06a5',
        appName: 'WhatsApp',
        text: 'Will stay in camlux',
        seenCount: 0
      }
    ];

    // Call the agent
    const ranking = await agent.handleContext({
      notifications,
      user_datetime: '2025-05-26T05:35:40.141Z'
    });

    // Output the ranking
    console.log('\n--- Notification Ranking ---');
    console.log(JSON.stringify(ranking, null, 2));
    console.log('---------------------------\n');
  }
}