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

Mentra Live ships with `com.mentra.asg_client` as a **system app** signed with Mentra's release key. To run your own build, `./scripts/dev-setup.sh` installs a fork alongside it under a separate package (`com.mentra.asg_client.thirdparty`), disables the stock app, and makes your build the default launcher; `./scripts/restore-stock.sh` reverses this.

### Connecting via ADB

#### USB ADB

Snap the Infinity Cable onto the contacts on the right temple, plug the other end into your computer, then run `adb devices` to confirm. USB debugging ships enabled and authorized from the factory.

#### WiFi ADB

Find the glasses' Local IP Address in the MentraOS app (Glasses screen), then:

```bash
adb connect <GLASSES_IP>:5555
adb devices
```

### Installing Your Custom Build of asg_client

```bash
./scripts/dev-setup.sh
```

This script will:

1. Build your debug APK
2. Install it as `com.mentra.asg_client.thirdparty`, disable the stock app, and set your build as the default launcher
3. Grant all required permissions

**Warning:** Your fork will not receive OTA updates from Mentra.

### Restoring Stock Firmware

```bash
./scripts/restore-stock.sh
```

This removes your custom build and restores the factory app.

### Build Notes

Must use Java SDK 17. To set this, in Android Studio, go to Settings > Build, Execution, Deployment > Build Tools > Gradle, go to Gradle JDK and select version 17

### Documentation

See [docs/](docs/README.md) for architecture overview, command API reference, and feature docs.
