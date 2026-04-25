plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mentra.examples.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mentra.examples.android"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            pickFirsts += "lib/**/libonnxruntime.so"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("com.mentra:bluetooth-sdk:${property("mentraSdkVersion")}")
}
