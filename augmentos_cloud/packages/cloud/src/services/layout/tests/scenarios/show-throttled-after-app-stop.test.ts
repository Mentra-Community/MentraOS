/**
 * Test for showing throttled requests when an app stops
 *
 * This tests the improved behavior where when an app is stopped,
 * any throttled requests from other apps are shown immediately
 * instead of clearing the display.
 */

import DisplayManager from '../../DisplayManager6.1';
import { MockUserSession } from '../harness/MockUserSession';
import { DisplayRequest, AppToCloudMessageType, ViewType, LayoutType } from '@augmentos/sdk';
import { strict as assert } from 'assert';
import { systemApps } from '../../../core/system-apps';

// App package names for testing
const APP1 = 'com.example.app1';
const APP2 = 'com.example.app2';

/**
 * Test that throttled requests from other apps are shown immediately when an app stops
 */
export async function testShowThrottledAfterAppStop() {
  console.log('Testing that throttled requests from other apps are shown when an app stops');

  try {
    // Create DisplayManager and user session
    const userSession = new MockUserSession('test-user');
    const displayManager = new DisplayManager(userSession as any);

    // Lower the throttle delay for testing (we'll test the immediate show behavior, not the timeout)
    displayManager['THROTTLE_DELAY'] = 1000; // 1 second

    console.log('1. Set up environment with two running apps');
    // Add both apps to active sessions
    userSession.addActiveApp(APP1);
    userSession.addActiveApp(APP2);

    console.log('2. App1 shows a display and acquires background lock');
    // Send a display request from App1
    const app1Request: DisplayRequest = {
      type: AppToCloudMessageType.DISPLAY_REQUEST,
      packageName: APP1,
      view: ViewType.MAIN,
      layout: {
        layoutType: LayoutType.TEXT_WALL,
        text: 'App1 Display'
      },
      timestamp: new Date(),
      forceDisplay: true
    };
    displayManager.handleDisplayRequest(app1Request);

    // Verify App1's display is current
    // @ts-ignore: We need to access private property for testing
    const currentDisplayBefore = displayManager['displayState'].currentDisplay;
    console.assert(currentDisplayBefore?.displayRequest.packageName === APP1,
      'App1 should be the current display');
    console.log('✓ App1 is the current display');

    console.log('3. Manually add a throttled request for App2');
    // Create a display request for App2
    const app2Request = {
      type: AppToCloudMessageType.DISPLAY_REQUEST,
      packageName: APP2,
      view: ViewType.MAIN,
      layout: {
        layoutType: LayoutType.TEXT_WALL,
        text: 'App2 Display'
      },
      timestamp: new Date()
    };

    // Directly create an ActiveDisplay for App2
    const app2ActiveDisplay: any = {
      displayRequest: app2Request,
      startedAt: new Date(),
      expiresAt: undefined
    };

    // Manually add App2's request to the throttle queue (since the normal path is blocked by background lock)
    // @ts-ignore: We need to access private property for testing
    displayManager['throttledRequests'].set(APP2, {
      activeDisplay: app2ActiveDisplay,
      timestamp: Date.now()
    });

    // Verify App1 is still displaying
    // @ts-ignore: We need to access private property for testing
    const displayAfterApp2 = displayManager['displayState'].currentDisplay;
    console.assert(displayAfterApp2?.displayRequest.packageName === APP1,
      'App1 should still be the current display');

    // Verify App2's request is in the throttle queue
    // @ts-ignore: We need to access private property for testing
    const throttledRequests = displayManager['throttledRequests'];
    console.assert(throttledRequests.has(APP2),
      'App2\'s request should be in the throttle queue');
    console.log('✓ App2\'s request is in throttle queue');

    console.log('4. Stop App1 (this should trigger App2\'s display to show immediately)');
    // Stop App1 and remove from active sessions
    userSession.removeActiveApp(APP1);
    displayManager.handleAppStop(APP1);

    // Verify App2's request is no longer in the throttle queue
    console.assert(!throttledRequests.has(APP2),
      'App2\'s request should no longer be in the throttle queue');

    // Verify App2 is now displaying
    // @ts-ignore: We need to access private property for testing
    const displayAfterStopApp1 = displayManager['displayState'].currentDisplay;

    if (!displayAfterStopApp1 || displayAfterStopApp1.displayRequest.packageName !== APP2) {
      throw new Error(`Expected App2 to be displaying after App1 stopped, but found ${
        displayAfterStopApp1 ? displayAfterStopApp1.displayRequest.packageName : 'no display'
      }`);
    }

    console.log('✓ App2\'s display is now showing (throttled request was processed immediately)');
    console.log('✅ Test passed! Throttled display from App2 is shown immediately when App1 is stopped');

  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  }
}

/**
 * Test that the oldest throttled request is chosen when multiple apps have them
 */
export async function testMultipleThrottledRequests() {
  console.log('Testing that the oldest throttled request is shown when multiple exist');

  try {
    // Create DisplayManager and user session
    const userSession = new MockUserSession('test-user');
    const displayManager = new DisplayManager(userSession as any);

    console.log('1. Set up environment with three running apps');
    // Add all apps to active sessions
    userSession.addActiveApp(APP1);
    userSession.addActiveApp(APP2);
    userSession.addActiveApp('com.example.app3');

    console.log('2. App1 shows a display and acquires background lock');
    // Send a display request from App1
    const app1Request: DisplayRequest = {
      type: AppToCloudMessageType.DISPLAY_REQUEST,
      packageName: APP1,
      view: ViewType.MAIN,
      layout: { layoutType: LayoutType.TEXT_WALL, text: 'App1 Display' },
      timestamp: new Date(),
      forceDisplay: true
    };
    displayManager.handleDisplayRequest(app1Request);

    console.log('3. Add throttled requests for App2 and App3 (with App2\'s being older)');
    // Manually add App2's request to the throttle queue (older)
    const app2ActiveDisplay: any = {
      displayRequest: {
        type: AppToCloudMessageType.DISPLAY_REQUEST,
        packageName: APP2,
        view: ViewType.MAIN,
        layout: { layoutType: LayoutType.TEXT_WALL, text: 'App2 Display' },
        timestamp: new Date()
      },
      startedAt: new Date(),
      expiresAt: undefined
    };

    // @ts-ignore: We need to access private property for testing
    displayManager['throttledRequests'].set(APP2, {
      activeDisplay: app2ActiveDisplay,
      timestamp: Date.now() - 1000 // Add 1 second ago (older)
    });

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 50));

    // Manually add App3's request to the throttle queue (newer)
    const app3ActiveDisplay: any = {
      displayRequest: {
        type: AppToCloudMessageType.DISPLAY_REQUEST,
        packageName: 'com.example.app3',
        view: ViewType.MAIN,
        layout: { layoutType: LayoutType.TEXT_WALL, text: 'App3 Display' },
        timestamp: new Date()
      },
      startedAt: new Date(),
      expiresAt: undefined
    };

    // @ts-ignore: We need to access private property for testing
    displayManager['throttledRequests'].set('com.example.app3', {
      activeDisplay: app3ActiveDisplay,
      timestamp: Date.now() // Just now (newer)
    });

    console.log('4. Stop App1 (App2\'s display should show since it\'s the oldest)');
    // Stop App1 and remove from active sessions
    userSession.removeActiveApp(APP1);
    displayManager.handleAppStop(APP1);

    // Verify App2 is now displaying (since it has the oldest throttled request)
    // @ts-ignore: We need to access private property for testing
    const displayAfterStopApp1 = displayManager['displayState'].currentDisplay;

    if (!displayAfterStopApp1 || displayAfterStopApp1.displayRequest.packageName !== APP2) {
      throw new Error(`Expected App2 to be displaying after App1 stopped, but found ${
        displayAfterStopApp1 ? displayAfterStopApp1.displayRequest.packageName : 'no display'
      }`);
    }

    console.log('✓ App2\'s display is now showing (oldest throttled request was processed)');
    console.log('✅ Test passed! Oldest throttled request (App2) was chosen when App1 stopped');

  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  }
}

/**
 * Test that stopped app's throttled requests are ignored when choosing what to show next
 */
export async function testStoppedAppThrottledRequests() {
  console.log('Testing that stopped app\'s throttled requests are ignored');

  try {
    // Create DisplayManager and user session
    const userSession = new MockUserSession('test-user');
    const displayManager = new DisplayManager(userSession as any);

    console.log('1. Set up environment with three running apps');
    // Add App1 and App2 to active sessions, but not App3
    userSession.addActiveApp(APP1);
    userSession.addActiveApp(APP2);

    console.log('2. App1 shows a display and acquires background lock');
    // Send a display request from App1
    const app1Request: DisplayRequest = {
      type: AppToCloudMessageType.DISPLAY_REQUEST,
      packageName: APP1,
      view: ViewType.MAIN,
      layout: { layoutType: LayoutType.TEXT_WALL, text: 'App1 Display' },
      timestamp: new Date(),
      forceDisplay: true
    };
    displayManager.handleDisplayRequest(app1Request);

    console.log('3. Add throttled requests for App2 and App3 (with App3\'s being older but from a stopped app)');
    // Manually add App3's request to the throttle queue (older but from stopped app)
    const app3ActiveDisplay: any = {
      displayRequest: {
        type: AppToCloudMessageType.DISPLAY_REQUEST,
        packageName: 'com.example.app3',
        view: ViewType.MAIN,
        layout: { layoutType: LayoutType.TEXT_WALL, text: 'App3 Display' },
        timestamp: new Date()
      },
      startedAt: new Date(),
      expiresAt: undefined
    };

    // @ts-ignore: We need to access private property for testing
    displayManager['throttledRequests'].set('com.example.app3', {
      activeDisplay: app3ActiveDisplay,
      timestamp: Date.now() - 2000 // Add 2 seconds ago (oldest)
    });

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 50));

    // Manually add App2's request to the throttle queue (newer but from running app)
    const app2ActiveDisplay: any = {
      displayRequest: {
        type: AppToCloudMessageType.DISPLAY_REQUEST,
        packageName: APP2,
        view: ViewType.MAIN,
        layout: { layoutType: LayoutType.TEXT_WALL, text: 'App2 Display' },
        timestamp: new Date()
      },
      startedAt: new Date(),
      expiresAt: undefined
    };

    // @ts-ignore: We need to access private property for testing
    displayManager['throttledRequests'].set(APP2, {
      activeDisplay: app2ActiveDisplay,
      timestamp: Date.now() - 1000 // Add 1 second ago (newer than App3)
    });

    console.log('4. Stop App1 (App2\'s display should show since App3 is not running)');
    // Stop App1 and remove from active sessions
    userSession.removeActiveApp(APP1);
    displayManager.handleAppStop(APP1);

    // Verify App2 is now displaying (since it's the only running app with a throttled request)
    // @ts-ignore: We need to access private property for testing
    const displayAfterStopApp1 = displayManager['displayState'].currentDisplay;

    if (!displayAfterStopApp1 || displayAfterStopApp1.displayRequest.packageName !== APP2) {
      throw new Error(`Expected App2 to be displaying after App1 stopped, but found ${
        displayAfterStopApp1 ? displayAfterStopApp1.displayRequest.packageName : 'no display'
      }`);
    }

    // Verify App3's request is still in the throttle queue (it was ignored)
    // @ts-ignore: We need to access private property for testing
    const throttledRequests = displayManager['throttledRequests'];
    console.assert(throttledRequests.has('com.example.app3'),
      'App3\'s request should still be in the throttle queue (it was ignored)');

    console.log('✓ App2\'s display is showing and App3\'s throttled request was ignored');
    console.log('✅ Test passed! Ignored throttled request from stopped app when choosing what to show next');

  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  }
}

// Run the tests when this module is loaded directly
if (require.main === module) {
  (async () => {
    try {
      console.log('\n==== Running testShowThrottledAfterAppStop ====');
      await testShowThrottledAfterAppStop();
      console.log('✅ Test completed successfully\n');

      console.log('\n==== Running testMultipleThrottledRequests ====');
      await testMultipleThrottledRequests();
      console.log('✅ Test completed successfully\n');

      console.log('\n==== Running testStoppedAppThrottledRequests ====');
      await testStoppedAppThrottledRequests();
      console.log('✅ Test completed successfully\n');

      console.log('🎉 All throttling tests passed!');
    } catch (error) {
      console.error('❌ Test failed:', error);
      process.exit(1);
    }
  })();
}