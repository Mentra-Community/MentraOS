# augmentos_asg_client

This is the Android code that runs on Android-based smart glasses (ex: Mentra Live).

## Documentation
- [ASG_MEDIA_SYSTEM.md](./ASG_MEDIA_SYSTEM.md) - Detailed documentation about the camera button press system, photo/video capture workflow, and how TPAs (Third Party Applications) can interact with the media system.

## Compatible Devices

### Tested
- Mentra Live

### Untested (likely compatible)
- TCL Rayneo X2
- INMO Air 2
- Other Android-based smart glasses

We'd appreciate testers for these untested devices - let us know if you get it working!

### Environment Setup

1. Create a `.env` file by copying the provided example:
   ```
   cp .env.example .env
   ```

2. By default, the example contains production settings:
   ```
   AUGMENTOS_HOST=cloud.augmentos.org
   AUGMENTOS_PORT=443
   AUGMENTOS_SECURE=true
   ```

3. For local development:
   - If using an Android device, you can use either:
     - The ADB tunnel: uncomment the localhost settings in `.env`
     - Your computer's local IP: replace `localhost` with your IP address
   - Ensure your device and computer are on the same network
   - To use ADB tunnel: `adb reverse tcp:8002 tcp:8002`

### Build Notes

- Must use Java SDK 17
    - To set this, in Android Studio, go to Settings > Build, Execution, Deployment > Build Tools > Gradle, go to Gradle JDK and select version 17

- augmentos_asg_client currently depends on the "SmartGlassesManager" repo being next to it. In the future, it will be fully merged with augmentos_asg_client and deleted.

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
9. Install APK on your phone (located in app/build/outputs/debug/).
