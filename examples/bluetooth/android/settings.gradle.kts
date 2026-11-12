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
includeBuild("../../../mobile/modules/bluetooth-sdk/android") {
    dependencySubstitution {
        substitute(module("com.mentraglass:bluetooth-sdk")).using(project(":"))
    }
}
