/**
 * Simple test to verify the basics of our test harness and DisplayManager
 */

import DisplayManager from '../../DisplayManager6.1';
import { MockUserSession } from '../harness/MockUserSession';
import { DisplayRequest, TpaToCloudMessageType, ViewType, LayoutType } from '@augmentos/sdk';
import { systemApps } from '../../../core/system-apps';

// Simple manual test to verify our fixes
export async function main() {
  console.log('Starting simple test...');
  
  // Create a mock user session
  const userSession = new MockUserSession('test-user');
  
  // Create a display manager
  const displayManager = new DisplayManager(userSession as any);
  
  // Create a simple display request
  const displayRequest: DisplayRequest = {
    type: TpaToCloudMessageType.DISPLAY_REQUEST,
    packageName: 'com.example.app1',
    view: ViewType.MAIN,
    layout: {
      layoutType: LayoutType.TEXT_WALL,
      text: 'Hello, World!'
    },
    timestamp: new Date()
  };
  
  // Send the display request
  console.log('Sending display request...');
  const result = displayManager.handleDisplayRequest(displayRequest);
  console.log('Display request result:', result);
  
  // Check the messages sent to the WebSocket
  const messages = userSession.getSentMessages();
  console.log(`WebSocket received ${messages.length} messages:`, messages);
  
  console.log('Test completed');
}

// Run the test if this file is executed directly
if (require.main === module) {
  main();
}