/**
 * Maestro runScript to inject test audio via ADB broadcast
 *
 * This script sends an ADB broadcast intent that the app listens for
 * to trigger audio injection from a file on device storage.
 */

const audioFile = env.audioFile || 'hello-world.wav';
const deviceTestDir = env.deviceTestDir || '/sdcard/Download/mentra-test';
const fullPath = `${deviceTestDir}/${audioFile}`;

// Use HTTP to communicate with a local test server that runs ADB commands
// The test server should be started before running tests
const http = require('http');

const options = {
  hostname: 'localhost',
  port: 8765,  // Test harness server port
  path: '/inject-audio',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const data = JSON.stringify({
  filePath: fullPath
});

// Note: Maestro's JS environment is limited - this is a conceptual implementation
// In practice, we may need to use a different approach

// For now, output the command that would need to be run
output.audioFile = audioFile;
output.fullPath = fullPath;
output.adbCommand = `adb shell am broadcast -a com.mentra.TEST_INJECT_AUDIO --es filePath "${fullPath}"`;

console.log(`Audio injection requested: ${fullPath}`);
console.log(`To manually trigger: ${output.adbCommand}`);
