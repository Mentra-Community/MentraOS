/**
 * MockDisplaySystem.ts
 *
 * Visualizes the current state of displays being shown on smart glasses
 * and provides a console-based representation for testing purposes.
 */

import { ActiveDisplay, DisplayRequest, LayoutType } from '@mentra/sdk';
import { systemApps } from '../../../core/system-apps';
import { TimeMachine } from './TimeMachine';

export interface DisplayRecord {
  timestamp: number;
  activeDisplay: ActiveDisplay;
  formattedContent: string;
}

export interface QueueRecord {
  appName: string;
  activeDisplay: ActiveDisplay;
  queueType: 'boot' | 'throttle';
  scheduledTime?: number;
}

export class MockDisplaySystem {
  private currentDisplay: DisplayRecord | null = null;
  private displayHistory: DisplayRecord[] = [];
  private queues: QueueRecord[] = [];
  private timeMachine: TimeMachine;

  constructor(timeMachine: TimeMachine) {
    this.timeMachine = timeMachine;
  }

  /**
   * Update the current display being shown
   */
  setCurrentDisplay(activeDisplay: ActiveDisplay): void {
    const timestamp = this.timeMachine.getCurrentTime();

    const formattedContent = this.formatDisplayContent(activeDisplay.displayRequest);

    const record: DisplayRecord = {
      timestamp,
      activeDisplay,
      formattedContent
    };

    this.currentDisplay = record;
    this.displayHistory.push(record);
  }

  /**
   * Add an item to the queue (boot or throttle)
   */
  addToQueue(
    appName: string,
    activeDisplay: ActiveDisplay,
    queueType: 'boot' | 'throttle',
    scheduledTime?: number
  ): void {
    // Remove any existing queue item for this app and type
    this.queues = this.queues.filter(
      q => !(q.appName === appName && q.queueType === queueType)
    );

    // Add new queue item
    this.queues.push({
      appName,
      activeDisplay,
      queueType,
      scheduledTime
    });
  }

  /**
   * Remove an item from the queue
   */
  removeFromQueue(appName: string, queueType: 'boot' | 'throttle'): void {
    this.queues = this.queues.filter(
      q => !(q.appName === appName && q.queueType === queueType)
    );
  }

  /**
   * Format a display request's content for visualization
   */
  private formatDisplayContent(displayRequest: DisplayRequest): string {
    const { packageName, layout } = displayRequest;

    // Special handling for boot screen
    if (
      packageName === systemApps.dashboard.packageName &&
      layout.layoutType === LayoutType.REFERENCE_CARD &&
      typeof layout.title === 'string' &&
      layout.title.includes('Starting App')
    ) {
      return 'Boot Screen: ' + (layout.text || '');
    }

    // Handle different layout types
    switch (layout.layoutType) {
      case LayoutType.TEXT_WALL:
        return layout.text || '';

      case LayoutType.REFERENCE_CARD:
        return `[${layout.title || ''}] ${layout.text || ''}`;

      default:
        return JSON.stringify(layout);
    }
  }

  /**
   * Generate a visual representation of the current display
   */
  visualize(): string {
    let output = '[MockDisplaySystem]\n';

    // Current display
    if (this.currentDisplay) {
      const { timestamp, activeDisplay, formattedContent } = this.currentDisplay;
      const { packageName, layout } = activeDisplay.displayRequest;

      output += '┌─────────────────────────────────────────────────┐\n';
      output += '│ CURRENT DISPLAY (main view)                     │\n';
      output += '│                                                 │\n';
      output += `│ Package: ${packageName.padEnd(40)}│\n`;
      output += `│ Layout: ${(layout.layoutType as string).padEnd(42)}│\n`;

      // Format content to fit in box
      const contentLines = formattedContent.split('\n');
      for (const line of contentLines.slice(0, 3)) {
        output += `│ Content: "${line.substring(0, 39).padEnd(39)}" │\n`;
      }

      if (contentLines.length > 3) {
        output += '│ Content: "... (truncated)" ...                 │\n';
      }

      output += '│                                                 │\n';
      output += `│ Sent at: ${TimeMachine.formatTime(timestamp).padEnd(40)}│\n`;
      output += '└─────────────────────────────────────────────────┘\n\n';
    } else {
      output += 'No active display\n\n';
    }

    // Queues
    if (this.queues.length > 0) {
      output += 'QUEUES:\n';

      // Boot queue
      const bootQueue = this.queues.filter(q => q.queueType === 'boot');
      if (bootQueue.length > 0) {
        output += 'BOOT QUEUE:\n';
        for (const item of bootQueue) {
          const content = this.formatDisplayContent(item.activeDisplay.displayRequest);
          output += `- ${item.appName}: "${content.substring(0, 30)}${content.length > 30 ? '...' : ''}"\n`;
        }
        output += '\n';
      }

      // Throttle queue
      const throttleQueue = this.queues.filter(q => q.queueType === 'throttle');
      if (throttleQueue.length > 0) {
        output += 'THROTTLE QUEUE:\n';
        for (const item of throttleQueue) {
          const content = this.formatDisplayContent(item.activeDisplay.displayRequest);
          const timeInfo = item.scheduledTime
            ? ` (scheduled at ${TimeMachine.formatTime(item.scheduledTime)})`
            : '';
          output += `- ${item.appName}${timeInfo}: "${content.substring(0, 30)}${content.length > 30 ? '...' : ''}"\n`;
        }
        output += '\n';
      }
    }

    return output;
  }

  /**
   * Generate a timeline of display events
   */
  generateTimeline(): string {
    if (this.displayHistory.length === 0) {
      return 'No display history recorded';
    }

    let output = 'DISPLAY TIMELINE:\n\n';
    output += 'TIME     | PACKAGE                  | CONTENT\n';
    output += '---------|--------------------------|---------------------------\n';

    for (const record of this.displayHistory) {
      const { timestamp, activeDisplay, formattedContent } = record;
      const { packageName } = activeDisplay.displayRequest;

      const time = TimeMachine.formatTime(timestamp);
      const content = formattedContent.substring(0, 25) + (formattedContent.length > 25 ? '...' : '');

      output += `${time} | ${packageName.padEnd(25)} | ${content}\n`;
    }

    return output;
  }

  /**
   * Get the current display
   */
  getCurrentDisplay(): ActiveDisplay | null {
    return this.currentDisplay?.activeDisplay || null;
  }

  /**
   * Get the display history
   */
  getDisplayHistory(): DisplayRecord[] {
    return [...this.displayHistory];
  }

  /**
   * Clear all history and state
   */
  reset(): void {
    this.currentDisplay = null;
    this.displayHistory = [];
    this.queues = [];
  }
}