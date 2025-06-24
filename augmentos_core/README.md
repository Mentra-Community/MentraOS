# MentraOS_Core

This is the Android code that runs on the Puck device.

### Build Notes

- Must use Java SDK 17
    - To set this, in Android Studio, go to Settings > Build, Execution, Deployment > Build Tools > Gradle, go to Gradle JDK and select version 17

- MentraOS_Core currently depends on the "SmartGlassesManager" repo being next to it. In the future, it will be fully merged with MentraOS_Core and deleted.

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
