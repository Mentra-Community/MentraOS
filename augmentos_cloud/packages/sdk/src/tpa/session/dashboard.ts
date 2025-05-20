/**
 * Dashboard API Implementation
 * 
 * Provides dashboard functionality for TPAs, allowing them to write content
 * to the dashboard and respond to dashboard mode changes.
 */
import { systemApps } from '../../constants';
import { 
  DashboardAPI, 
  DashboardContentAPI, 
  DashboardMode, 
  DashboardSystemAPI,
  DashboardContentUpdate,
  DashboardModeChange,
  DashboardSystemUpdate
} from '../../types/dashboard';
import { TpaToCloudMessageType } from '../../types/message-types';
import { Layout } from '../../types/layouts';
import { EventManager } from './events';

// Import TpaSession interface for typing
import type { TpaSession } from './index';
import { TpaToCloudMessage } from 'src/types';

/**
 * Implementation of DashboardSystemAPI interface for system dashboard TPA
 */
export class DashboardSystemManager implements DashboardSystemAPI {
  constructor(
    private session: TpaSession,
    private packageName: string,
    private send: (message: any) => void
  ) {}

  setTopLeft(content: string): void {
    this.updateSystemSection('topLeft', content);
  }

  setTopRight(content: string): void {
    this.updateSystemSection('topRight', content);
  }

  setBottomLeft(content: string): void {
    this.updateSystemSection('bottomLeft', content);
  }

  setBottomRight(content: string): void {
    this.updateSystemSection('bottomRight', content);
  }

  setViewMode(mode: DashboardMode): void {
    const message: DashboardModeChange = {
      type: TpaToCloudMessageType.DASHBOARD_MODE_CHANGE,
      packageName: this.packageName,
      sessionId: `${this.session.getSessionId()}-${this.packageName}`,
      mode,
      timestamp: new Date()
    };
    this.send(message);
  }

  private updateSystemSection(section: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight', content: string): void {
    const message: DashboardSystemUpdate = {
      type: TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE,
      packageName: this.packageName,
      sessionId: `${this.session.getSessionId()}-${this.packageName}`,
      section,
      content,
      timestamp: new Date()
    };
    this.send(message);
  }
}

/**
 * Implementation of DashboardContentAPI interface for all TPAs
 */
export class DashboardContentManager implements DashboardContentAPI {
  private currentMode: DashboardMode | 'none' = 'none';
  // private alwaysOnEnabled: boolean = false;
  
  constructor(
    private session: TpaSession,
    private packageName: string,
    private send: (message: any) => void,
    private events: EventManager
  ) {}

  write(content: string, targets: DashboardMode[] = [DashboardMode.MAIN]): void {
    const message: DashboardContentUpdate = {
      type: TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
      packageName: this.packageName,
      sessionId: `${this.session.getSessionId()}-${this.packageName}`,
      content,
      modes: targets,
      timestamp: new Date()
    };
    this.send(message);
  }

  writeToMain(content: string): void {
    this.write(content, [DashboardMode.MAIN]);
  }

  writeToExpanded(content: string): void {
    const message: DashboardContentUpdate = {
      type: TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
      packageName: this.packageName,
      sessionId: `${this.session.getSessionId()}-${this.packageName}`,
      content,
      modes: [DashboardMode.EXPANDED],
      timestamp: new Date()
    };
    this.send(message);
  }

  // writeToAlwaysOn(content: string): void {
  //   this.write(content, [DashboardMode.ALWAYS_ON]);
  // }

  async getCurrentMode(): Promise<DashboardMode | 'none'> {
    return this.currentMode;
  }

  // async isAlwaysOnEnabled(): Promise<boolean> {
  //   return this.alwaysOnEnabled;
  // }

  onModeChange(callback: (mode: DashboardMode | 'none') => void): () => void {
    return this.events.onDashboardModeChange((data) => {
      this.currentMode = data.mode;
      callback(data.mode);
    });
  }
  
  // onAlwaysOnChange(callback: (enabled: boolean) => void): () => void {
  //   return this.events.onDashboardAlwaysOnChange((data) => {
  //     this.alwaysOnEnabled = data.enabled;
  //     callback(data.enabled);
  //   });
  // }

  // Internal methods to update state
  setCurrentMode(mode: DashboardMode | 'none'): void {
    this.currentMode = mode;
    this.events.emit('dashboard_mode_change', { mode });
  }

  // setAlwaysOnEnabled(enabled: boolean): void {
  //   this.alwaysOnEnabled = enabled;
  //   this.events.emit('dashboard_always_on_change', { enabled });
  // }
}

/**
 * Dashboard Manager - Main class that manages dashboard functionality
 * Each TpaSession instance gets its own DashboardManager instance
 */
export class DashboardManager implements DashboardAPI {
  public readonly content: DashboardContentAPI;
  public readonly system?: DashboardSystemAPI;

  constructor(session: TpaSession, send: (message: TpaToCloudMessage) => void) {
    const packageName = session.getPackageName();
    const events = session.events;

    // Create content API (available to all TPAs)
    this.content = new DashboardContentManager(session, packageName, send, events);
    
    // Add system API if this is the system dashboard TPA
    if (packageName === systemApps.dashboard.packageName) {
      this.system = new DashboardSystemManager(session, packageName, send);
    }
  }
}
