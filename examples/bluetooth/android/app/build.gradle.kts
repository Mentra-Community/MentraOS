plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mentra.examples.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mentra.examples.android"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    implementation("com.mentra:bluetooth-sdk:${property("mentraSdkVersion")}")
}
