# AugmentOS Setup Guide

## Getting Started

1. Configure Environment
   - Copy `.env.example` to create your `.env` file
   - Configure server settings in `.env` (default: localhost)

2. Install & Start: `npm start`

3. Launch the backend:

From the augmentos_cloud folder: `./run.sh`

4. Connecting your phone to your local backend:

### Android
You have two options:

- Use your computer's local IP address:
  - Find your IP with `ifconfig` or in System Preferences → Network
  - Update your `.env` file with your computer's IP
  - Ensure both your phone and computer are on the same WiFi network

- Or create a localhost tunnel over USB (preferred for development):
  ```
  adb reverse tcp:8002 tcp:8002
  ```

### iOS
For iOS devices, use your computer's local IP address:

- Find your IP with `ifconfig` or in System Preferences → Network
- Update your `.env` file with your computer's IP
- Ensure both your iOS device and computer are on the same WiFi network
- After changing the `.env`, rebuild the app in Xcode



## iOS Setup

1. Install dependencies: `npm install`
2. Install pods: `cd ios && pod install && cd ..`
3. Open the workspace: `open ios/AugmentOS_Manager.xcworkspace`
4. Run the app: `Product -> Run`

### iOS Node Path Configuration

By default, Xcode uses the `.xcode.env` file which contains `NODE_BINARY=$(command -v node)` to find your node installation. If you experience node-related build errors:

1. Create a file at `ios/.xcode.env.local` with your specific node path:
   ```
   export NODE_BINARY=/path/to/your/node
   ```

2. Tips for finding your node path:
   - NVM users: Run `which node` in terminal and use that exact path
   - Homebrew users: Typically `/opt/homebrew/bin/node`
   - Make sure the node version matches project requirements (Node 18+)
   - This file is gitignored so each developer can set their own path

3. After making this change, clean the build and restart Xcode

### Debugging

- Try deleting the `ios/build`, `ios/Podfile.lock`, and `ios/Pods` folders and then re-running `pod install`
- Try deleting XCode's derived data: `rm -rf ~/Library/Developer/Xcode/DerivedData`
