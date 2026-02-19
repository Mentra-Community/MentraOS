import { Widget } from './widgets/Widget';
import { WidgetRegistry } from './widgets/WidgetRegistry';
import { OmniFocusWidget } from './widgets/OmniFocusWidget';
import { CalendarWidget } from './widgets/CalendarWidget';
import { WeatherWidget } from './widgets/WeatherWidget';
import { TeleprompterWidget } from './widgets/TeleprompterWidget';
import { mpCliBridge } from './MpCliBridge';
import miniComms from './MiniComms';
import { BackgroundTimer } from '@/utils/timers';
import GlobalEventEmitter from '@/utils/GlobalEventEmitter';
import { NativeModules, Platform } from 'react-native';

const { MediaButtonHandlerModule } = NativeModules;

/**
 * DashboardManager
 * Manages multiple widgets with contextual display based on head position
 */
class DashboardManager {
  private static instance: DashboardManager;
  private registry: WidgetRegistry;
  private currentWidgetIndex: number = 0;
  private refreshTimers: Map<string, ReturnType<typeof BackgroundTimer.setInterval>> = new Map();
  private _isRunning: boolean = false;
  private isHeadUp: boolean = false;
  private headsUpWidgets: string[] = ['weather']; // Quick glance info
  private headsDownWidgets: string[] = ['calendar', 'teleprompter']; // Detailed info
  private contextualSwitchingEnabled: boolean = true; // Can be disabled for manual control

  private constructor() {
    this.registry = WidgetRegistry.getInstance();
    this.initializeWidgets();
    this.setupHeadPositionListener();
  }

  public static getInstance(): DashboardManager {
    if (!DashboardManager.instance) {
      DashboardManager.instance = new DashboardManager();
    }
    return DashboardManager.instance;
  }

  public isRunning(): boolean {
    return this._isRunning;
  }

  public getCurrentWidget(): Widget | null {
    const widgets = this.registry.getEnabledWidgets();
    return widgets[this.currentWidgetIndex] || null;
  }

  public setContextualSwitching(enabled: boolean) {
    this.contextualSwitchingEnabled = enabled;
    console.log(`[DashboardManager] Contextual switching ${enabled ? 'enabled' : 'disabled'}`);
  }

  public async nextWidget() {
    await this.next();
  }

  public async previousWidget() {
    await this.previous();
  }

  private initializeWidgets() {
    // Register default widgets
    const omnifocus = new OmniFocusWidget();
    omnifocus.enabled = false; // Disabled by default (requires mp-cli)
    this.registry.register(omnifocus);
    
    this.registry.register(new CalendarWidget());
    this.registry.register(new WeatherWidget());
    this.registry.register(new TeleprompterWidget());
  }

  /**
   * Setup head position listener
   */
  private setupHeadPositionListener() {
    // Listen for head position changes from Core (event name: "head_up")
    GlobalEventEmitter.addListener('head_up', (data: { up: boolean }) => {
      const wasHeadUp = this.isHeadUp;
      this.isHeadUp = data.up;
      
      // Only switch widgets if contextual switching is enabled
      if (wasHeadUp !== this.isHeadUp && this._isRunning && this.contextualSwitchingEnabled) {
        console.log(`[DashboardManager] Head position changed: ${this.isHeadUp ? 'UP' : 'DOWN'}`);
        this.displayContextualWidget();
      }
    });

    // Stop dashboard on BLE disconnect
    GlobalEventEmitter.addListener('glasses_disconnected', () => {
      console.log('[DashboardManager] Glasses disconnected, stopping dashboard');
      this.stop();
    });
  }

  /**
   * Display widget based on head position
   */
  private async displayContextualWidget() {
    const targetWidgets = this.isHeadUp ? this.headsUpWidgets : this.headsDownWidgets;
    const enabledWidgets = this.registry.getEnabledWidgets();
    
    // Find first enabled widget that matches context
    const widget = enabledWidgets.find(w => targetWidgets.includes(w.id));
    
    if (widget) {
      // Update current index to match
      const allEnabled = this.registry.getEnabledWidgets();
      this.currentWidgetIndex = allEnabled.findIndex(w => w.id === widget.id);
      await this.displayCurrentWidget();
    }
  }

  /**
   * Start the dashboard
   */
  async start() {
    if (this._isRunning) return;
    
    console.log('[DashboardManager] Starting...');
    this._isRunning = true;

    // Configure mp-cli bridge (TODO: get from settings)
    mpCliBridge.configure(
      'http://192.168.0.91:8421/api/v1',
      '3l2LMHhjg5BH-XJfon0VmqIkhA1ZA9Dv1FWVnsxcbXU'
    );

    // Enable media button handler (iOS)
    if (Platform.OS === 'ios') {
      console.log('[DashboardManager] MediaButtonHandlerModule exists:', !!MediaButtonHandlerModule);
      if (MediaButtonHandlerModule) {
        console.log('[DashboardManager] Enabling media button handler...');
        try {
          MediaButtonHandlerModule.enable();
          console.log('[DashboardManager] Media button handler enabled');
        } catch (error) {
          console.error('[DashboardManager] Failed to enable media button handler:', error);
        }
      }
    }

    // Start with weather widget (heads up default)
    const widgets = this.registry.getEnabledWidgets();
    const weatherIndex = widgets.findIndex(w => w.id === 'weather');
    if (weatherIndex >= 0) {
      this.currentWidgetIndex = weatherIndex;
    }

    // Display current widget
    await this.displayCurrentWidget();

    // Start refresh timers for all enabled widgets
    this.startRefreshTimers();

    // Listen for button presses
    this.setupButtonListener();

    console.log('[DashboardManager] Started');
  }

  /**
   * Stop the dashboard
   */
  stop() {
    if (!this._isRunning) return;
    
    console.log('[DashboardManager] Stopping...');
    this._isRunning = false;

    // Disable media button handler (iOS)
    if (Platform.OS === 'ios' && MediaButtonHandlerModule) {
      MediaButtonHandlerModule.disable();
    }

    // Clear all refresh timers
    this.stopRefreshTimers();

    // Remove button listener
    if (GlobalEventEmitter && GlobalEventEmitter.removeListener) {
      GlobalEventEmitter.removeListener('BUTTON_PRESS', this.handleButtonPress);
    }

    console.log('[DashboardManager] Stopped');
  }

  /**
   * Setup button press listener
   */
  private setupButtonListener() {
    GlobalEventEmitter.on('BUTTON_PRESS', this.handleButtonPress);
  }

  /**
   * Handle button press events
   */
  private handleButtonPress = async (event: {buttonId: string; pressType: string; timestamp: number}) => {
    console.log('🎮 [DashboardManager] Button press received:', event);

    const currentWidget = this.getCurrentWidget();
    
    // Map media buttons to actions
    let action: 'next' | 'previous' | 'refresh' | null = null;
    
    if (event.buttonId === 'next' || event.buttonId === 'play') {
      action = 'next';
    } else if (event.buttonId === 'previous' || event.buttonId === 'pause') {
      action = 'previous';
    }
    
    if (!action) {
      console.log('[DashboardManager] Unknown button, ignoring:', event.buttonId);
      return;
    }
    
    console.log(`[DashboardManager] Action: ${action}`);
    
    // Special handling for Teleprompter widget
    if (currentWidget?.id === 'teleprompter') {
      const teleprompter = currentWidget as TeleprompterWidget;
      
      if (action === 'next') {
        await teleprompter.next();
        await this.displayCurrentWidget();
      } else if (action === 'previous') {
        await teleprompter.previous();
        await this.displayCurrentWidget();
      }
      return;
    }

    // Default behavior for other widgets
    if (action === 'next') {
      await this.next();
    } else if (action === 'previous') {
      await this.previous();
    }
  };

  /**
   * Navigate to next widget
   */
  async next() {
    const enabledWidgets = this.registry.getEnabledWidgets();
    if (enabledWidgets.length === 0) return;

    this.currentWidgetIndex = (this.currentWidgetIndex + 1) % enabledWidgets.length;
    await this.displayCurrentWidget();
  }

  /**
   * Navigate to previous widget
   */
  async previous() {
    const enabledWidgets = this.registry.getEnabledWidgets();
    if (enabledWidgets.length === 0) return;

    this.currentWidgetIndex = (this.currentWidgetIndex - 1 + enabledWidgets.length) % enabledWidgets.length;
    await this.displayCurrentWidget();
  }

  /**
   * Refresh current widget
   */
  async refresh() {
    console.log('[DashboardManager] Manual refresh');
    await this.displayCurrentWidget();
  }

  /**
   * Get all widgets
   */
  getAllWidgets(): Widget[] {
    return this.registry.getAllWidgets();
  }

  /**
   * Set widget enabled state
   */
  setWidgetEnabled(widgetId: string, enabled: boolean) {
    this.registry.setWidgetEnabled(widgetId, enabled);
    
    if (this._isRunning) {
      // Restart timers to reflect changes
      this.stopRefreshTimers();
      this.startRefreshTimers();
    }
  }

  /**
   * Display the current widget on glasses
   */
  private async displayCurrentWidget() {
    const widget = this.getCurrentWidget();
    if (!widget) {
      miniComms.sendToGlasses('No widgets enabled');
      return;
    }

    try {
      // console.log(`[DashboardManager] Displaying widget: ${widget.name}`);
      
      const data = await widget.fetchData();
      const formatted = widget.formatDisplay(data);
      
      // Send to main view (heads down)
      miniComms.sendToGlasses(formatted);
      
      // Also send to dashboard view (heads up) via socket
      const socketComms = require('./SocketComms').default;
      socketComms.handle_display_event({
        type: "display_event",
        view: "dashboard",
        layout: {
          layoutType: "text_wall",
          text: formatted,
        },
      });
      
      // console.log(`[DashboardManager] Sent to glasses: ${formatted.substring(0, 50)}...`);
    } catch (error) {
      console.error(`[DashboardManager] Error displaying widget ${widget.id}:`, error);
      miniComms.sendToGlasses(`Error loading ${widget.name}`);
    }
  }

  /**
   * Start refresh timers for all enabled widgets
   */
  private startRefreshTimers() {
    const enabledWidgets = this.registry.getEnabledWidgets();
    
    enabledWidgets.forEach(widget => {
      const timer = BackgroundTimer.setInterval(async () => {
        // Only refresh if this is the current widget
        const current = this.getCurrentWidget();
        if (current?.id === widget.id) {
          await this.displayCurrentWidget();
        }
      }, widget.refreshInterval * 1000);
      
      this.refreshTimers.set(widget.id, timer);
    });
  }

  /**
   * Stop all refresh timers
   */
  private stopRefreshTimers() {
    this.refreshTimers.forEach(timer => {
      BackgroundTimer.clearInterval(timer);
    });
    this.refreshTimers.clear();
  }
}

export default DashboardManager;
