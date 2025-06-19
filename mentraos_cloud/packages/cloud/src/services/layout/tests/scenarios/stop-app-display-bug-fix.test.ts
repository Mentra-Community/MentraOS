/**
 * Test for fixed bug: Display from stopped app incorrectly restored after boot
 * 
 * This tests the fix for a bug where displays from stopped apps were being
 * incorrectly restored after a new app's boot screen completed.
 */

import DisplayManager from '../../DisplayManager6.1';
import { MockUserSession } from '../harness/MockUserSession';
import { DisplayRequest, TpaToCloudMessageType, ViewType, LayoutType } from '@augmentos/sdk';
import { strict as assert } from 'assert';
import { systemApps } from '../../../core/system-apps';

// App package names
const APP1 = 'com.example.app1';
const APP2 = 'com.example.app2';

/**
 * Test that displays from stopped apps are not restored after boot
 */
export async function testNoDisplayRestoreForStoppedApps() {
  console.log('Testing that stopped app displays are not restored after boot');
  
  // Create the display manager and user session
  const userSession = new MockUserSession('test-user');
  const displayManager = new DisplayManager(userSession as any);
  
  // Utility function to create a display request
  function createDisplayRequest(packageName: string, text: string): DisplayRequest {
    return {
      type: TpaToCloudMessageType.DISPLAY_REQUEST,
      packageName,
      view: ViewType.MAIN,
      layout: {
        layoutType: LayoutType.TEXT_WALL,
        text
      },
      timestamp: new Date()
    };
  }
  
  try {
    console.log('1. Start App1');
    // Add App1 to active apps and start it
    userSession.addActiveApp(APP1);
    displayManager.handleAppStart(APP1);
    
    // Wait for boot to complete (simulate time passing)
    console.log('2. Simulate boot completion for App1');
    displayManager.handleAppStop(APP1); // Stops the boot screen
    userSession.addActiveApp(APP1); // Re-add the app to active apps
    
    console.log('3. App1 shows a display');
    // App1 sends a display request - force display to bypass throttling
    const app1Display = createDisplayRequest(APP1, 'Display from App1');
    app1Display.forceDisplay = true; // Add this to bypass throttling
    const result1 = displayManager.handleDisplayRequest(app1Display);
    assert.equal(result1, true, 'App1 display request should be accepted');
    
    // Verify App1's display was sent
    const lastApp1Message = userSession.getLastSentMessage();
    assert.equal(lastApp1Message?.packageName, APP1, 'App1 display should be sent');
    
    console.log('4. Stop App1');
    // Stop App1
    userSession.removeActiveApp(APP1);
    displayManager.handleAppStop(APP1);
    
    console.log('5. Start App2');
    // Start App2 (which shows a boot screen)
    userSession.addActiveApp(APP2);
    displayManager.handleAppStart(APP2);
    
    // Verify boot screen is showing
    const bootScreenMessage = userSession.getLastSentMessage();
    assert.ok(bootScreenMessage?.layout?.title?.includes('Starting App'), 'Boot screen should be showing');
    
    console.log('6. Wait for App2 boot to complete');
    // Complete boot for App2
    displayManager.handleAppStop(APP2);
    userSession.addActiveApp(APP2); // Re-add the app to active apps
    
    // Check what's showing now
    const finalMessage = userSession.getLastSentMessage();
    
    console.log('7. Verify App1 display is NOT restored');
    // Verify it's NOT App1's display
    assert.notEqual(finalMessage?.packageName, APP1, 
      'App1 display should NOT be restored after boot since App1 is stopped');
    
    console.log('✅ Test passed! App1 display was not restored after App2 boot screen.');
  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  }
}

// Run the test
if (require.main === module) {
  (async () => {
    try {
      await testNoDisplayRestoreForStoppedApps();
      console.log('Test completed successfully');
    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    }
  })();
}