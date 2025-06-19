# augmentos_ota_updater
# OTA Updater Setup Guide

## 1. Prepare Devices

- Enable hotspot on your phone.
- Connect both the Glasses and your laptop to the same hotspot (to ensure local IP access).
- Find the local IP address of the Glasses. On Samsung Galaxy phones, this is often displayed in the hotspot's connected devices section.

### Connect the Glasses via ADB
```bash
adb connect {GLASSES_IP}:5555
```

### Connect Your Phone via USB

Run the following command:
```bash
adb devices
```

**Sample output:**
```
List of devices attached
48171JEGR13921        device    # This is the phone
10.175.187.202:5555   device    # This is the glasses
```

## 2. Target ADB to Specific Devices

To prevent command confusion, export `ANDROID_SERIAL`:

- **Terminal 1 (for Glasses):**
```bash
export ANDROID_SERIAL={GLASSES_IP}:5555
```

- **Terminal 2 (for Phone):**
```bash
export ANDROID_SERIAL=48171JEGR13921
```

## 3. Mirror Glasses Screen

In a separate terminal:
```bash
scrcpy -s {GLASSES_IP}:5555
```

## 4. Keep Glasses Screen Awake for a Short Time

- In terminal with Glasses targeted:
```bash
adb shell svc power stayon true
```

- Alternatively:
```bash
adb -s {GLASSES_IP}:5555 shell svc power stayon true
```

# Package Info and Permissions

## List Installed Packages Related to AugmentOS
```bash
adb -s {GLASSES_IP} shell pm list packages | grep augmentos
```

### Grant File Access Permission to Glasses Apps

**Add this to the app manifest:**
```xml
<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage" />
```

**Grant permission via ADB:**
```bash
adb shell appops set {APP_PACKAGE_NAME} MANAGE_EXTERNAL_STORAGE allow
```

### Secure Broadcast Communication

**Add this to the manifest of the receiver app:**
```xml
<uses-permission android:name="com.augmentos.otaupdater.PERMISSION_OTA_COMMAND" />
```
//TODO list
#### Notify the manager app to check if `/storage/emulated/0/asg` exists
#### Create a backup of the current app before updating