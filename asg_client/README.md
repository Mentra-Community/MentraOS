# Mentra asg_client

A MentraOS glasses client that runs on Android-based smart glasses such as Mentra Live.

### Compatible Devices

- Mentra Live

### Environment Setup

1. Create a `.env` file by copying the provided example:

   ```
   cp .env.example .env
   ```

2. By default, the example contains production settings:

   ```
   MENTRAOS_HOST=api.mentra.glass
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

Mentra Live ships with `com.mentra.asg_client` as a **system app** signed with Mentra's release key. To run your own build, you must replace the factory app.

### Connecting via ADB

Connect your Mentra Live using the **Infinity Cable** (magnetic USB-C clip-on cable). Run `adb devices` to confirm connection.

### Installing Your Custom Build

```bash
./scripts/dev-setup.sh
```

This script will:
1. Build your debug APK
2. Replace the factory app with your build
3. Grant all required permissions

**Warning:** After running this, you will not receive OTA updates from Mentra. You are responsible for your own builds.

### Restoring Stock Firmware

```bash
./scripts/restore-stock.sh
```

This removes your custom build and restores the factory app.

### Build Notes

Must use Java SDK 17. To set this, in Android Studio, go to Settings > Build, Execution, Deployment > Build Tools > Gradle, go to Gradle JDK and select version 17
