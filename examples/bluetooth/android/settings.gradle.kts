pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "MentraDesignerAndroidExample"
include(":app")

// Build the Bluetooth SDK from the MentraOS source tree. Gradle substitutes the
// app's com.mentraglass:bluetooth-sdk dependency with this included build.
// The standalone Starter Kit replaces this block with the published version.
// Its name addresses its own tasks from here, such as the SDK's hardware tests:
// ./gradlew :mentra-bluetooth-sdk:assembleDebugAndroidTest
includeBuild("../../../mobile/modules/bluetooth-sdk/android") {
    name = "mentra-bluetooth-sdk"
    dependencySubstitution {
        substitute(module("com.mentraglass:bluetooth-sdk")).using(project(":"))
    }
}
