# ASG Client (Android Smart Glasses Client)

Android application that runs on Android-based smart glasses like Mentra Live. Connects to MentraOS Cloud via WebSocket and manages hardware interfaces (camera, microphone, LED control, sensors).

## Compatible Devices

**Officially Supported:**

- Mentra Live

## Build Commands

### Development

- **Build Debug APK**: `./gradlew assembleDebug`
- **Build Release APK**: `./gradlew assembleRelease`
- **Install on Device**: `./gradlew installDebug`
- **Clean Build**: `./gradlew clean`
- **Run Tests**: `./gradlew test`

### APK Location

- Debug: `app/build/outputs/apk/debug/app-debug.apk`
- Release: `app/build/outputs/apk/release/app-release.apk`

## Prerequisites

### Required Software

- **Java SDK 17** (required)
  - In Android Studio: Settings > Build, Execution, Deployment > Build Tools > Gradle > Gradle JDK > Select version 17
- Android Studio (latest stable version)
- Android SDK 34
- Gradle 8.0+

### Dependencies

- **StreamPackLite**: RTMP streaming library (must be cloned separately)
  ```bash
  cd asg_client
  git clone git@github.com:Mentra-Community/StreamPackLite.git
  cd StreamPackLite
  git checkout working
  ```
- **SmartGlassesManager**: Currently required to be in a sibling directory (will be merged into asg_client in the future)

## Environment Setup

1. **Create .env file**:

   ```bash
   cp .env.example .env
   ```

2. **Default Production Configuration**:

   ```
   MENTRAOS_HOST=cloud.mentra.glass
   MENTRAOS_PORT=443
   MENTRAOS_SECURE=true
   ```

3. **Local Development Configuration**:
   ```
   MENTRAOS_HOST=192.168.1.100  # Your local machine's IP
   MENTRAOS_PORT=9090
   MENTRAOS_SECURE=false
   ```

## Development on Mentra Live

### Important: Factory App Uninstall Required

Mentra Live glasses ship with `com.mentra.asg_client` signed with our release key. Since this key is not public, **you must uninstall the factory app** before you can install your own debug build.

### Quick Setup Script

After connecting via ADB, run the setup script:

```bash
./scripts/dev-setup.sh
```

This script will:

1. Uninstall the factory-signed app
2. Install your debug APK (if built)
3. Grant all required runtime permissions

### Manual Setup

```bash
# 1. Uninstall factory app
adb uninstall com.mentra.asg_client

# 2. Build and install your debug APK
./gradlew installDebug

# 3. Grant permissions (run after install)
adb shell pm grant com.mentra.asg_client android.permission.CAMERA
adb shell pm grant com.mentra.asg_client android.permission.RECORD_AUDIO
adb shell pm grant com.mentra.asg_client android.permission.ACCESS_FINE_LOCATION
adb shell pm grant com.mentra.asg_client android.permission.BLUETOOTH_CONNECT
adb shell pm grant com.mentra.asg_client android.permission.BLUETOOTH_SCAN
adb shell pm grant com.mentra.asg_client android.permission.POST_NOTIFICATIONS
```

## ADB Connection (Mentra Live)

Connect via the **magnetic USB-C clip-on cable** that comes with your Mentra Live. Just attach the cable and run `adb devices` to confirm connection.

Alternatively, you can use ADB over WiFi:

1. Pair Mentra Live in the MentraOS mobile app
2. Connect glasses to your local WiFi network (in MentraOS app)
3. Get the IP address from "Glasses" screen in MentraOS app
4. Run: `adb connect <IP_ADDRESS>:5555`

## Project Structure

```
asg_client/
├── app/src/main/java/com/mentra/asg_client/
│   ├── service/        # Main services (WebSocket, foreground service)
│   ├── camera/         # Camera capture and streaming
│   ├── audio/          # Audio capture and processing
│   ├── hardware/       # Hardware interfaces (LED, sensors)
│   ├── settings/       # Settings management
│   ├── reporting/      # Sentry error reporting
│   ├── sensors/        # Sensor data processing
│   ├── io/             # I/O utilities
│   ├── utils/          # Utility classes
│   ├── di/             # Dependency injection
│   └── receiver/       # Broadcast receivers
├── agents/             # Feature documentation
├── StreamPackLite/     # RTMP streaming library (external)
├── credentials/        # Debug keystore (not committed)
├── AGENTS.md           # Development guide
├── CLAUDE.md           # AI assistant reference
└── README.md           # Project overview
```

## Code Style Guidelines

### Java

- **Java Version**: Java 17 required
- **Classes**: PascalCase (e.g., `AsgClientService`)
- **Methods**: camelCase (e.g., `connectToCloud()`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_RETRY_ATTEMPTS`)
- **Member Variables**: mCamelCase with 'm' prefix (e.g., `mWebSocketClient`)
- **Indentation**: 2 spaces
- **Braces**: Opening brace on same line

### Documentation

- **Javadoc**: Required for public methods and classes
- **Comments**: Explain "why" not "what"
- **TODOs**: Use `// TODO: Description` format

### Architecture

- **Dependency Injection**: Use Dagger/Hilt patterns in `/di` package
- **Error Reporting**: Use Sentry via reporting package
- **Logging**: Use Android Logcat with appropriate tags
- **Services**: Follow Android foreground service best practices

## Key Features

### Hardware Management

- **Camera**: Photo/video capture with button press detection
- **LED Control**: RGB LED control for device feedback (K900-specific)
- **Sensors**: Accelerometer, gyroscope data streaming
- **Audio**: Microphone capture and streaming

### Cloud Communication

- **WebSocket**: Persistent connection to MentraOS Cloud
- **Media Streaming**: RTMP streaming via StreamPackLite
- **Event Handling**: Camera button events, sensor data

### Settings

- Persistent configuration using SharedPreferences
- Cloud endpoint configuration
- Hardware feature toggles

## Documentation Reference

- **README.md** - Project overview and quick start
- **agents/BES_OTA_README.md** - BES OTA update system
- **agents/CAMERA_WEBSERVER_README.md** - Camera web server documentation
- **agents/CUSTOM_GATT_AUDIO.md** - Custom GATT audio implementation
- **agents/DELETE_FILES_ENDPOINT.md** - File deletion endpoint documentation
- **agents/K900_LED_CONTROL.md** - K900 LED control system
- **agents/PHOTO_TESTING_GUIDE.md** - Photo capture testing guide
- **agents/RGB_LED_CONTROL_IMPLEMENTATION.md** - RGB LED control details
- **app/src/main/java/com/mentra/asg_client/reporting/SENTRY_CONFIGURATION.md** - Sentry error reporting setup
- **app/src/main/java/com/mentra/asg_client/reporting/README.md** - Comprehensive reporting system guide

## Common Tasks

### Adding a New Feature

1. Create feature package under `com.mentra.asg_client.<feature>`
2. Implement service/activity as needed
3. Add dependency injection if required
4. Update documentation
5. Test on physical Mentra Live device

### Debugging

1. Connect via ADB (see ADB Connection section)
2. Use Android Studio Logcat
3. Filter by tag: "ASGClient"
4. Check Sentry dashboard for production errors

### Building for Release

1. Ensure signing credentials are set (ASG_STORE_PASSWORD, ASG_KEY_PASSWORD)
2. Run `./gradlew assembleRelease`
3. APK will be in `app/build/outputs/apk/release/`

## Testing

- **Unit Tests**: `./gradlew test`
- **Connected Tests**: `./gradlew connectedAndroidTest` (requires connected device)
- **Manual Testing**: Install on Mentra Live and test with MentraOS mobile app

## Known Issues & Notes

- SmartGlassesManager dependency will be merged into this repo in the future
- Some features are K900 hardware-specific (LED control)
- For OGG/Orbis C++ builds, see "Building OGG/Orbis C++ for ASP" section in README.md

## Build Troubleshooting

### Common Issues

**"Failed to find Java SDK 17"**

- Set Gradle JDK to version 17 in Android Studio settings

**"StreamPackLite not found"**

- Clone StreamPackLite repo in asg_client directory
- Checkout `working` branch

**"SmartGlassesManager dependency not found"**

- Ensure SmartGlassesManager repo is in sibling directory

**Gradle version conflicts**

- Install Gradle 8.0.2 if needed
- Run `chmod 777 ./gradle/` if permission issues

This project runs on Android-based smart glasses and requires physical hardware for full testing.
