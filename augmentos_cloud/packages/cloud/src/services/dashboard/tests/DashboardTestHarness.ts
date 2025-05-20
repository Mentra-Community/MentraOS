/**
 * Dashboard Test Harness
 * 
 * A testing framework for the dashboard system.
 * Simulates the display manager and WebSocket service to test dashboard functionality.
 */
import { 
  DashboardMode,
  Layout,
  systemApps,
  TpaToCloudMessageType,
  DashboardContentUpdate,
  DashboardModeChange,
  DashboardSystemUpdate,
  LayoutType,
  ViewType
} from '@augmentos/sdk';
import { logger } from '@augmentos/utils';
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
}

// Mock WebSocket service
class MockWebSocketService {
  private tpaMessageHandlers: Map<string, Function> = new Map();
  private tpaDisconnectHandlers: Function[] = [];
  private glassesMessages: any[] = [];
  private tpaMessages: any[] = [];
  
  registerTpaMessageHandler(type: string, handler: Function): void {
    this.tpaMessageHandlers.set(type, handler);
  }
  
  onTpaDisconnected(handler: Function): void {
    this.tpaDisconnectHandlers.push(handler);
  }
  
  broadcastToGlasses(message: any): void {
    this.glassesMessages.push(message);
    console.log('Message to glasses:', message);
  }
  
  broadcastToTpas(message: any): void {
    this.tpaMessages.push(message);
    console.log('Message to TPAs:', message);
  }
  
  // Test methods
  simulateTpaMessage(message: any): void {
    const type = message.type;
    const handler = this.tpaMessageHandlers.get(type);
    
    if (handler) {
      handler(message);
    } else {
      console.warn(`No handler registered for message type: ${type}`);
    }
  }
  
  simulateTpaDisconnect(packageName: string): void {
    this.tpaDisconnectHandlers.forEach(handler => {
      handler(packageName);
    });
  }
  
  getGlassesMessages(): any[] {
    return this.glassesMessages;
  }
  
  getTpaMessages(): any[] {
    return this.tpaMessages;
  }
  
  clearMessages(): void {
    this.glassesMessages = [];
    this.tpaMessages = [];
  }
}

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
    this.dashboardManager = new DashboardManager(
      this.wsService as any,
      this.displayManager as any,
      {
        updateIntervalMs: 100, // Faster updates for testing
        queueSize: 3
      }
    );
    
    logger.info('Dashboard Test Harness initialized');
  }
  
  /**
   * Send content from a regular TPA to the dashboard
   */
  sendTpaContent(packageName: string, content: string, modes: DashboardMode[] = [DashboardMode.MAIN]): void {
    const message: DashboardContentUpdate = {
      type: TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
      packageName,
      content,
      modes,
      timestamp: new Date()
    };
    
    this.wsService.simulateTpaMessage(message);
  }
  
  /**
   * Update system dashboard section
   */
  updateSystemSection(section: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight', content: string): void {
    const message: DashboardSystemUpdate = {
      type: TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE,
      packageName: systemApps.dashboard.packageName,
      section,
      content,
      timestamp: new Date()
    };
    
    this.wsService.simulateTpaMessage(message);
  }
  
  /**
   * Change dashboard mode
   */
  changeDashboardMode(mode: DashboardMode): void {
    const message: DashboardModeChange = {
      type: TpaToCloudMessageType.DASHBOARD_MODE_CHANGE,
      packageName: systemApps.dashboard.packageName,
      mode,
      timestamp: new Date()
    };
    
    this.wsService.simulateTpaMessage(message);
  }
  
  /**
   * Simulate a TPA disconnecting
   */
  disconnectTpa(packageName: string): void {
    this.wsService.simulateTpaDisconnect(packageName);
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
    
    // Send content from multiple TPAs
    this.sendTpaContent('com.example.weather', 'Weather: Sunny, 72°F');
    this.sendTpaContent('com.example.calendar', 'Meeting with Team @ 1:00 PM');
    this.sendTpaContent('com.example.messages', 'New message from John: "Are we still on for lunch?"');
    
    // Change to expanded mode
    setTimeout(() => {
      console.log('\n>>> Changing to EXPANDED mode');
      this.changeDashboardMode(DashboardMode.EXPANDED);
      
      // Send expanded content
      this.sendTpaContent('com.example.tasks', 'Current tasks:\n- Finish dashboard implementation\n- Test with glasses\n- Write documentation', [DashboardMode.EXPANDED]);
    }, 1000);
    
    // Change to always-on mode
    setTimeout(() => {
      console.log('\n>>> Changing to ALWAYS-ON mode');
      this.changeDashboardMode(DashboardMode.ALWAYS_ON);
      
      // Send always-on content
      this.sendTpaContent('com.example.fitness', 'Steps: 5,280', [DashboardMode.ALWAYS_ON]);
    }, 2000);
    
    // Test always-on overlay
    setTimeout(() => {
      console.log('\n>>> Enabling ALWAYS-ON overlay with MAIN mode');
      this.changeDashboardMode(DashboardMode.MAIN);
      this.setAlwaysOnEnabled(true);
    }, 3000);
    
    // Test TPA disconnect
    setTimeout(() => {
      console.log('\n>>> Disconnecting a TPA');
      this.disconnectTpa('com.example.messages');
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
    
    // Add content from multiple TPAs
    console.log('\n>>> Starting apps and adding content');
    this.sendTpaContent('app1', 'App 1 Content');
    this.sendTpaContent('app2', 'App 2 Content');
    this.sendTpaContent('app3', 'App 3 Content');
    
    // Simulate app updates
    setTimeout(() => {
      console.log('\n>>> Updating app content');
      this.sendTpaContent('app1', 'App 1 Updated Content');
      this.sendTpaContent('app3', 'App 3 Updated Content');
    }, 1000);
    
    // Simulate app stopping
    setTimeout(() => {
      console.log('\n>>> Stopping app2');
      this.disconnectTpa('app2');
    }, 2000);
    
    // Add new app
    setTimeout(() => {
      console.log('\n>>> Starting app4');
      this.sendTpaContent('app4', 'App 4 Content');
    }, 3000);
    
    // Stop all apps
    setTimeout(() => {
      console.log('\n>>> Stopping all apps');
      this.disconnectTpa('app1');
      this.disconnectTpa('app3');
      this.disconnectTpa('app4');
    }, 4000);
    
    // End test
    setTimeout(() => {
      console.log('\n=== APP LIFECYCLE TEST COMPLETE ===');
    }, 5000);
  }
}