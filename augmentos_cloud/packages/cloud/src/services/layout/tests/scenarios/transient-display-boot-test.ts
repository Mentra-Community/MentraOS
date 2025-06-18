/**
 * Test for transient display behavior during boot sequences
 *
 * This tests the specific scenario where a display has already been shown and
 * "consumed" (shown and then disappeared or replaced), and should not be restored
 * after a subsequent app's boot screen completes.
 */

import DisplayManager from '../../DisplayManager6.1';
import { MockUserSession } from '../harness/MockUserSession';
import { DisplayRequest, AppToCloudMessageType, ViewType, LayoutType } from '@augmentos/sdk';
import { strict as assert } from 'assert';
import { systemApps } from '../../../core/system-apps';

// App package names for testing
const APP1 = 'com.example.app1'; // First app (Mira)
const APP2 = 'com.example.app2'; // Second app

/**
 * Test that a consumed display is not restored after a boot sequence
 */
export async function testTransientDisplayNotRestored() {
  console.log('Testing that displayed & consumed content is not restored after a boot sequence');

  try {
    // Create DisplayManager and user session
    const userSession = new MockUserSession('test-user');
    const displayManager = new DisplayManager(userSession as any);

    console.log('1. Start App1 (simulate Mira TPA)');
    // Add App1 to active sessions and start it
    userSession.addActiveApp(APP1);
    displayManager.handleAppStart(APP1);

    console.log('2. Complete App1\'s boot sequence');
    // Wait for boot to complete
    displayManager.handleAppStop(APP1);

    console.log('3. App1 sends a display request that gets shown');
    // App1 sends a display request
    const app1Request: DisplayRequest = {
      type: AppToCloudMessageType.DISPLAY_REQUEST,
      packageName: APP1,
      view: ViewType.MAIN,
      layout: {
        layoutType: LayoutType.TEXT_WALL,
        text: 'Connect to Mira...'
      },
      timestamp: new Date(),
      durationMs: 0, // No explicit duration
      forceDisplay: true
    };
    displayManager.handleDisplayRequest(app1Request);

    // Verify App1's display is showing
    // @ts-ignore: We need to access private property for testing
    const displayAfterApp1 = displayManager['displayState'].currentDisplay;
    console.assert(displayAfterApp1?.displayRequest.packageName === APP1,
      'App1\'s display should be showing');
    console.log('✓ App1\'s display is shown');

    console.log('4. Simulate passage of time (display is "consumed")');
    // Simulate time passing (1.5 seconds) - the display is now considered "consumed"
    // @ts-ignore: We need to access private property for testing
    displayAfterApp1.startedAt = new Date(Date.now() - 1500);

    // Also release any background lock App1 might have obtained
    // @ts-ignore: We need to access private property for testing
    if (displayManager['displayState'].backgroundLock?.packageName === APP1) {
      // @ts-ignore: We need to access private property for testing
      displayManager['displayState'].backgroundLock = null;
      console.log('✓ Released App1\'s background lock to simulate content being dismissed');
    }

    console.log('5. Start App2');
    // Add App2 to active sessions and start it (triggers boot screen)
    userSession.addActiveApp(APP2);
    displayManager.handleAppStart(APP2);

    // Verify boot screen is showing
    // @ts-ignore: We need to access private property for testing
    const bootScreen = displayManager['displayState'].currentDisplay;
    console.assert(bootScreen?.displayRequest.packageName === systemApps.dashboard.packageName,
      'Boot screen should be showing');
    console.log('✓ Boot screen is showing');

    // Verify App1's display was NOT saved (since it's considered consumed)
    // @ts-ignore: We need to access private property for testing
    console.assert(!displayManager['displayState'].savedDisplayBeforeBoot ||
                  displayManager['displayState'].savedDisplayBeforeBoot.displayRequest.packageName !== APP1,
                  'App1\'s display should not be saved for restoration');
    console.log('✓ App1\'s display is NOT saved for restoration (consumed display)');

    console.log('6. Complete App2\'s boot sequence');
    // Complete App2's boot
    displayManager.handleAppStop(APP2);

    // Verify App1's display was NOT restored
    // @ts-ignore: We need to access private property for testing
    const displayAfterBoot = displayManager['displayState'].currentDisplay;

    if (displayAfterBoot?.displayRequest.packageName === APP1) {
      throw new Error(`App1's display was incorrectly restored after App2's boot screen`);
    }

    console.log('✓ App1\'s display was NOT restored after App2\'s boot screen');
    console.log('✅ Test passed! Consumed display was not restored');

  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  }
}

// Run the test when this module is loaded directly
if (require.main === module) {
  (async () => {
    try {
      await testTransientDisplayNotRestored();
      console.log('Test completed successfully');
    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    }
  })();
}