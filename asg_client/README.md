# asg_client

This is the Android code that runs on Android-based smart glasses (ex: Mentra Live).

## Documentation

### Development Guides

- [AGENTS.md](./AGENTS.md) - Complete development guide with build commands, setup instructions, and code style guidelines
- [CLAUDE.md](./CLAUDE.md) - AI assistant reference file

### Feature Documentation

- [BES_OTA_README.md](./agents/BES_OTA_README.md) - BES OTA update system
- [CAMERA_WEBSERVER_README.md](./agents/CAMERA_WEBSERVER_README.md) - Camera web server implementation
- [CUSTOM_GATT_AUDIO.md](./agents/CUSTOM_GATT_AUDIO.md) - Custom GATT audio protocol
- [DELETE_FILES_ENDPOINT.md](./agents/DELETE_FILES_ENDPOINT.md) - File deletion endpoint documentation
- [K900_LED_CONTROL.md](./agents/K900_LED_CONTROL.md) - K900-specific LED control
- [RGB_LED_CONTROL_IMPLEMENTATION.md](./agents/RGB_LED_CONTROL_IMPLEMENTATION.md) - RGB LED control details
- [PHOTO_TESTING_GUIDE.md](./agents/PHOTO_TESTING_GUIDE.md) - Photo capture testing guide

### Error Reporting & Analytics

- [SENTRY_CONFIGURATION.md](app/src/main/java/com/mentra/asg_client/reporting/SENTRY_CONFIGURATION.md) - Guide for configuring Sentry error reporting securely
- [Reporting System](./app/src/main/java/com/mentra/asg_client/reporting/README.md) - Comprehensive reporting and analytics system guide

## Compatible Devices

- Mentra Live

### Environment Setup

1. Create a `.env` file by copying the provided example:

   ```
   cp .env.example .env
   ```

2. By default, the example contains production settings:

   ```
   MENTRAOS_HOST=cloud.mentra.glass
   MENTRAOS_PORT=443
   MENTRAOS_SECURE=true
   ```

3. Clone the RTMP streaming library in this directory
   ```
   git clone git@github.com:Mentra-Community/StreamPackLite.git
   cd StreamPackLite
   git checkout working
   ```

### Development on Mentra Live

**Important:** Mentra Live glasses ship with `com.mentra.asg_client` signed with our release key. Since this key is not public, you **must uninstall the factory app** before installing your own debug build.

#### Quick Setup

We provide a script that handles uninstalling the factory app and granting permissions:

```bash
# Connect to your glasses first (see below), then:
./scripts/dev-setup.sh
```

#### Manual Setup

If you prefer to do it manually:

1. **Uninstall the factory app:**

   ```bash
   adb uninstall com.mentra.asg_client
   ```

2. **Build and install your debug APK:**

   ```bash
   ./gradlew installDebug
   ```

3. **Grant runtime permissions:**
   ```bash
   # Grant key permissions (some may fail - that's normal)
   adb shell pm grant com.mentra.asg_client android.permission.CAMERA
   adb shell pm grant com.mentra.asg_client android.permission.RECORD_AUDIO
   adb shell pm grant com.mentra.asg_client android.permission.ACCESS_FINE_LOCATION
   adb shell pm grant com.mentra.asg_client android.permission.BLUETOOTH_CONNECT
   adb shell pm grant com.mentra.asg_client android.permission.BLUETOOTH_SCAN
   adb shell pm grant com.mentra.asg_client android.permission.POST_NOTIFICATIONS
   adb shell pm grant com.mentra.asg_client android.permission.READ_MEDIA_IMAGES
   adb shell pm grant com.mentra.asg_client android.permission.READ_MEDIA_VIDEO
   ```

### How to Connect to Mentra Live with ADB

Connect via the **magnetic USB-C clip-on cable** that comes with your Mentra Live. Just attach the cable and run `adb devices` to confirm connection.

Alternatively, you can use ADB over WiFi:

1. Pair your Mentra Live in the MentraOS app
2. Connect it to your local WiFi network in the MentraOS app
3. Get its IP address from the "Glasses" screen in the MentraOS app
4. Run: `adb connect {IP_ADDRESS}:5555`

### Build Notes

- Must use Java SDK 17
  - To set this, in Android Studio, go to Settings > Build, Execution, Deployment > Build Tools > Gradle, go to Gradle JDK and select version 17

- asg_client currently depends on the "SmartGlassesManager" repo being next to it. In the future, it will be fully merged with asg_client and deleted.

##### Building OGG/Orbis C++ for ASP

(Disregard this section unless you are an OG H4CK3R... if you have to ask, you are not an OG H4CK3R)

You only have to follow these specific steps if you are building the OGG/Orbis C++ code. Otherwise, things will likely work with your regular Android Studio setup.

1. Run Linux (as you should be).
2. Install Java 17.
3. Ensure Java 17 is the default Java (can be set with `sudo update-java-alternatives`).
4. Run `chmod 777 ./gradle/` and `chmod 777 ./gradle/`.
5. Set your ANDROID_SDK_PATH WITH `export $ANDROID_SDK_PATH=<path to you Android>`.
6. Go into the Android folder and run `bash build_all.sh` to build everything.
7. If you get gradle version issues, install gradle 8.0.2: https://linuxhint.com/installing_gradle_ubuntu/ (follow the instructions, but replace 7.4.2 with 8.0.2).
8. For Subsequent builds, you can just run `assembleDebug --stacktrace` to build the APK.
9. Install APK on your glasses device (located in app/build/outputs/debug/).
