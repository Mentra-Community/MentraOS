// Shake your iPhone and select "Enable Remote JS Debugging"
// Or run this to enable console logging to file
import * as FileSystem from 'expo-file-system';

const originalLog = console.log;
const logFile = FileSystem.documentDirectory + 'debug.log';

console.log = (...args) => {
  const message = args.join(' ');
  originalLog(...args);
  FileSystem.appendAsync(logFile, message + '\n').catch(() => {});
};
