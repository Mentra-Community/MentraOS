/**
 * Resource Tracker
 * 
 * A utility class for tracking and automatically cleaning up resources
 * like timers, event listeners, and other disposable objects.
 * 
 * This helps prevent memory leaks by ensuring that all resources are
 * properly disposed when they're no longer needed.
 */

/**
 * Type for a cleanup function that doesn't take any arguments
 */
export type CleanupFunction = () => void;

/**
 * Type for any object with a dispose or close method
 */
export interface Disposable {
  dispose?: () => void;
  close?: () => void;
}

/**
 * Manages resources to prevent memory leaks
 */
export class ResourceTracker {
  // Collection of cleanup functions to call when dispose() is called
  private cleanupFunctions: CleanupFunction[] = [];
  
  // Flag to track if this resource tracker has been disposed
  private isDisposed = false;
  
  /**
   * Add a cleanup function to be executed when dispose() is called
   * 
   * @param cleanup - The cleanup function to register
   * @returns A function that will remove this cleanup function
   */
  track(cleanup: CleanupFunction): CleanupFunction {
    if (this.isDisposed) {
      throw new Error('Cannot track resources on a disposed ResourceTracker');
    }
    
    this.cleanupFunctions.push(cleanup);
    
    // Return a function that will remove this cleanup function
    return () => {
      const index = this.cleanupFunctions.indexOf(cleanup);
      if (index !== -1) {
        this.cleanupFunctions.splice(index, 1);
      }
    };
  }
  
  /**
   * Track a disposable object (anything with a dispose or close method)
   * 
   * @param disposable - The object to track
   * @returns A function that will remove this disposable
   */
  trackDisposable(disposable: Disposable): CleanupFunction {
    return this.track(() => {
      if (typeof disposable.dispose === 'function') {
        disposable.dispose();
      } else if (typeof disposable.close === 'function') {
        disposable.close();
      }
    });
  }
  
  /**
   * Track a timer and ensure it gets cleared
   * 
   * @param timerId - The timer ID to track
   * @param isInterval - Whether this is an interval (true) or timeout (false)
   * @returns A function that will remove this timer
   */
  trackTimer(timerId: NodeJS.Timeout, isInterval = false): CleanupFunction {
    return this.track(() => {
      if (isInterval) {
        clearInterval(timerId);
      } else {
        clearTimeout(timerId);
      }
    });
  }
  
  /**
   * Track a timeout and ensure it gets cleared
   * 
   * @param timerId - The timeout ID to track
   * @returns A function that will remove this timeout
   */
  trackTimeout(timerId: NodeJS.Timeout): CleanupFunction {
    return this.trackTimer(timerId, false);
  }
  
  /**
   * Track an interval and ensure it gets cleared
   * 
   * @param timerId - The interval ID to track
   * @returns A function that will remove this interval
   */
  trackInterval(timerId: NodeJS.Timeout): CleanupFunction {
    return this.trackTimer(timerId, true);
  }
  
  /**
   * Create a tracked timeout
   * 
   * @param callback - Function to call when the timeout expires
   * @param ms - Milliseconds to wait
   * @returns The timeout ID
   */
  setTimeout(callback: (...args: any[]) => void, ms: number): NodeJS.Timeout {
    const timerId = setTimeout(callback, ms);
    this.trackTimeout(timerId);
    return timerId;
  }
  
  /**
   * Create a tracked interval
   * 
   * @param callback - Function to call at each interval
   * @param ms - Milliseconds between intervals
   * @returns The interval ID
   */
  setInterval(callback: (...args: any[]) => void, ms: number): NodeJS.Timeout {
    const timerId = setInterval(callback, ms);
    this.trackInterval(timerId);
    return timerId;
  }
  
  /**
   * Dispose of all tracked resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    // Run all cleanup functions
    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch (error) {
        console.error('Error during resource cleanup:', error);
      }
    }
    
    // Clear the array
    this.cleanupFunctions = [];
    this.isDisposed = true;
  }
  
  /**
   * Check if this tracker has been disposed
   */
  get disposed(): boolean {
    return this.isDisposed;
  }
}

/**
 * Create a new ResourceTracker instance
 * 
 * @returns A new ResourceTracker
 */
export function createResourceTracker(): ResourceTracker {
  return new ResourceTracker();
}