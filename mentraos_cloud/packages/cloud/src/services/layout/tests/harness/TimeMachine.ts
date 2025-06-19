/**
 * TimeMachine.ts
 * 
 * Controls time flow for testing time-dependent behaviors in DisplayManager.
 * Allows tests to advance time without waiting for actual time to pass.
 */

export class TimeMachine {
  private currentTime: number = 0;
  private timeCallbacks: Map<number, Array<() => void>> = new Map();
  private originalDateNow: () => number;

  constructor() {
    this.originalDateNow = Date.now;
    
    // Don't override Date constructor, which can cause issues
    // Just override Date.now for timing
    Date.now = () => this.getCurrentTime();
  }

  /**
   * Get the current virtual time
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * Set the current virtual time to a specific timestamp
   */
  setCurrentTime(timestamp: number): void {
    this.currentTime = timestamp;
  }

  /**
   * Advance time by the specified number of milliseconds
   * and trigger any scheduled callbacks that should have fired
   */
  advanceBy(ms: number): void {
    const targetTime = this.currentTime + ms;
    
    // Find all callbacks scheduled to run before the target time
    const callbackTimes = Array.from(this.timeCallbacks.keys()).sort((a, b) => a - b);
    
    for (const time of callbackTimes) {
      if (time <= targetTime) {
        // Advance time to the callback time
        this.currentTime = time;
        
        // Get callbacks for this time
        const callbacks = this.timeCallbacks.get(time) || [];
        
        // Remove callbacks for this time
        this.timeCallbacks.delete(time);
        
        // Execute callbacks
        for (const callback of callbacks) {
          callback();
        }
      } else {
        // This and remaining times are beyond our target time
        break;
      }
    }
    
    // Set final time
    this.currentTime = targetTime;
  }

  /**
   * Advance time to a specific timestamp
   */
  advanceTo(timestamp: number): void {
    if (timestamp < this.currentTime) {
      throw new Error(`Cannot advance time backward from ${this.currentTime} to ${timestamp}`);
    }
    
    this.advanceBy(timestamp - this.currentTime);
  }

  /**
   * Schedule a callback to run after the specified delay
   */
  setTimeout(callback: () => void, delay: number): number {
    const executeTime = this.currentTime + delay;
    
    if (!this.timeCallbacks.has(executeTime)) {
      this.timeCallbacks.set(executeTime, []);
    }
    
    this.timeCallbacks.get(executeTime)!.push(callback);
    
    // Return a fake timer ID
    return executeTime;
  }

  /**
   * Clean up and restore original time behavior
   */
  cleanup(): void {
    // Restore original Date.now
    Date.now = this.originalDateNow;
  }

  /**
   * Format milliseconds as mm:ss.SSS
   */
  static formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = ms % 1000;
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
  }
}