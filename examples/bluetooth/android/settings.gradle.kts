pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
val mentraBluetoothSdkRoot = providers.environmentVariable("MENTRA_BLUETOOTH_SDK_PACKAGE_PATH").orNull

dependencyResolutionManagement {
    repositoriesMode.set(
        if (mentraBluetoothSdkRoot.isNullOrBlank()) {
            RepositoriesMode.FAIL_ON_PROJECT_REPOS
        } else {
            RepositoriesMode.PREFER_PROJECT
        }
    )
    repositories {
        if (!mentraBluetoothSdkRoot.isNullOrBlank()) {
            maven(file("$mentraBluetoothSdkRoot/android/libs/maven"))
        }
        mavenLocal()
        google()
        mavenCentral()
        maven("https://www.jitpack.io")
    }
}

rootProject.name = "MentraDesignerAndroidExample"
include(":app")

if (!mentraBluetoothSdkRoot.isNullOrBlank()) {
    include(":mentra-bluetooth-sdk")
    project(":mentra-bluetooth-sdk").projectDir = file("$mentraBluetoothSdkRoot/android")

    include(":lc3Lib")
    project(":lc3Lib").projectDir = file("$mentraBluetoothSdkRoot/android/lc3Lib")

    include(":silero")
    project(":silero").projectDir = file("$mentraBluetoothSdkRoot/android/silero")
}
